import { mkdir, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { S3Config } from "./config";
import { copyPrivateFile, writePrivateFile } from "./files";

export interface StorageReadStream {
    stream: ReadableStream<Uint8Array>;
    sizeBytes?: number;
}

/**
 * Minimal storage abstraction used by backup, restore, and rolling modules.
 * Keys use forward-slash as path separator on both backends (e.g. "daily/myfile.sql").
 */
export interface StorageAdapter {
    /** List all keys that start with the given prefix. */
    list(prefix: string): Promise<string[]>;
    /** Write data at the given key. */
    put(key: string, data: Uint8Array): Promise<void>;
    /** Stream a local file into storage at the given key without buffering the whole payload in RAM. */
    putFile?(key: string, localPath: string): Promise<void>;
    /** Read data at the given key. */
    get(key: string): Promise<Uint8Array>;
    /** Open a readable byte stream for the given key (plus optional size metadata). */
    getStream?(key: string): Promise<StorageReadStream>;
    /** Delete the given key. */
    delete(key: string): Promise<void>;
    /** Ensure the directory (or key prefix) exists — no-op on S3. */
    mkdir(path: string): Promise<void>;
}

/** Stream a local file into storage when supported, falling back to `put` for minimal adapters. */
export async function putFileToStorage(storage: StorageAdapter, key: string, localPath: string): Promise<void> {
    if (storage.putFile) {
        await storage.putFile(key, localPath);
        return;
    }
    const bytes = await Bun.file(localPath).bytes();
    await storage.put(key, bytes);
}

/** Open a stream from storage when supported, falling back to `get` for minimal adapters. */
export async function getStreamFromStorage(storage: StorageAdapter, key: string): Promise<StorageReadStream> {
    if (storage.getStream) {
        return await storage.getStream(key);
    }
    const bytes = await storage.get(key);
    return {
        sizeBytes: bytes.byteLength,
        stream: new ReadableStream<Uint8Array>({
            start(controller) {
                if (bytes.byteLength > 0) controller.enqueue(bytes);
                controller.close();
            },
        }),
    };
}

// ─── Local filesystem ─────────────────────────────────────────────────────────

export class LocalStorage implements StorageAdapter {
    constructor(private baseDir: string) {}

    async list(prefix: string): Promise<string[]> {
        // prefix may be "daily/", "daily/myprefix", or "monthly/mydb_2026_09"
        const lastSlash = prefix.lastIndexOf("/");
        const dirPart = lastSlash >= 0 ? prefix.slice(0, lastSlash) : "";
        const filePrefix = lastSlash >= 0 ? prefix.slice(lastSlash + 1) : prefix;
        const dir = dirPart ? join(this.baseDir, dirPart) : this.baseDir;
        try {
            const entries = await readdir(dir);
            const prefixPath = dirPart ? `${dirPart}/` : "";
            return entries.filter((e) => e.startsWith(filePrefix)).map((e) => `${prefixPath}${e}`);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
            throw error;
        }
    }

    async put(key: string, data: Uint8Array): Promise<void> {
        await writePrivateFile(join(this.baseDir, key), data);
    }

    async putFile(key: string, localPath: string): Promise<void> {
        await copyPrivateFile(localPath, join(this.baseDir, key));
    }

    async get(key: string): Promise<Uint8Array> {
        return await Bun.file(join(this.baseDir, key)).bytes();
    }

    async getStream(key: string): Promise<StorageReadStream> {
        const fullPath = join(this.baseDir, key);
        const file = Bun.file(fullPath);
        if (!(await file.exists())) {
            throw new Error(`Backup file not found: ${key}`);
        }
        return {
            stream: file.stream() as ReadableStream<Uint8Array>,
            sizeBytes: file.size,
        };
    }

    async delete(key: string): Promise<void> {
        await unlink(join(this.baseDir, key));
    }

    async mkdir(path: string): Promise<void> {
        await mkdir(join(this.baseDir, path), { recursive: true, mode: 0o700 });
    }
}

// ─── S3 (via Bun's built-in client) ──────────────────────────────────────────

const S3_PART_SIZE = 5 * 1024 * 1024; // 5 MiB multipart chunks

export class S3Storage implements StorageAdapter {
    private client: Bun.S3Client;
    private prefix: string;

    constructor(cfg: S3Config, prefix?: string) {
        this.client = new Bun.S3Client({
            accessKeyId: cfg.accessKeyId,
            secretAccessKey: cfg.secretAccessKey,
            ...(cfg.sessionToken ? { sessionToken: cfg.sessionToken } : {}),
            endpoint: cfg.endpoint,
            region: cfg.region,
            bucket: cfg.bucket,
        });
        // Normalise: ensure the prefix ends with "/" if non-empty
        this.prefix = prefix ? (prefix.endsWith("/") ? prefix : `${prefix}/`) : "";
    }

    private k(key: string): string {
        return `${this.prefix}${key}`;
    }

    async list(prefix: string): Promise<string[]> {
        const keys: string[] = [];
        const seen = new Set<string>();
        let continuationToken: string | undefined;
        let hasMore = true;
        while (hasMore) {
            const result = await this.client.list({ prefix: this.k(prefix), continuationToken });
            for (const item of result.contents ?? []) {
                if (item.key?.startsWith(this.k(prefix))) keys.push(item.key.slice(this.prefix.length));
            }
            if (!result.isTruncated) {
                hasMore = false;
                continue;
            }
            continuationToken = result.nextContinuationToken;
            if (!continuationToken || seen.has(continuationToken)) {
                throw new Error("S3 listing was truncated without a usable continuation token");
            }
            seen.add(continuationToken);
        }
        return keys;
    }

    async put(key: string, data: Uint8Array): Promise<void> {
        // Use multipart upload so large files are split into chunks,
        // avoiding 413 errors from nginx reverse proxies with low client_max_body_size.
        const writer = this.client.file(this.k(key)).writer({ partSize: S3_PART_SIZE });
        writer.write(data);
        await writer.end();
    }

    async putFile(key: string, localPath: string): Promise<void> {
        const writer = this.client.file(this.k(key)).writer({ partSize: S3_PART_SIZE });
        const stream = Bun.file(localPath).stream() as ReadableStream<Uint8Array>;
        for await (const chunk of stream) {
            writer.write(chunk);
            await writer.flush();
        }
        await writer.end();
    }

    async get(key: string): Promise<Uint8Array> {
        return await this.client.file(this.k(key)).bytes();
    }

    async getStream(key: string): Promise<StorageReadStream> {
        const s3File = this.client.file(this.k(key));
        const metadata = await s3File.stat();
        return {
            stream: s3File.stream() as ReadableStream<Uint8Array>,
            sizeBytes: metadata.size,
        };
    }

    async delete(key: string): Promise<void> {
        await this.client.delete(this.k(key));
    }

    async mkdir(_path: string): Promise<void> {
        // S3 has no real directories — keys with "/" in the name form a virtual hierarchy.
    }
}
