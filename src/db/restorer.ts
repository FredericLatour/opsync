import { PassThrough, Readable } from "node:stream";
import { createGunzip } from "node:zlib";
import type { DbConfig } from "../config";
import { assertSafePathSegment } from "../files";
import { backupFilenamePattern } from "../rolling";
import type { StorageAdapter } from "../storage";
import { buildRestoreCommand, type DatabaseDialect, runDatabaseCommand, streamDatabaseRestore } from "./client";

export interface BackupFileEntry {
    key: string;
    folder: string;
    filename: string;
    isGzip: boolean;
}

export interface RestoreExecutionOptions {
    targetDb: DbConfig;
    /** Buffered SQL bytes (already prepared). Mutually exclusive with `sqlStream`. */
    sqlData?: Uint8Array;
    /** Streamed SQL bytes (already prepared). Mutually exclusive with `sqlData`. */
    sqlStream?: ReadableStream<Uint8Array>;
    localDir?: string;
    container?: string;
}

const MYSQL_RESTORE_HEADER = new TextEncoder().encode(
    "SET autocommit=0;\nSET FOREIGN_KEY_CHECKS = 0;\nSET UNIQUE_CHECKS = 0;\n",
);
const MYSQL_RESTORE_FOOTER = new TextEncoder().encode(
    "\nSET UNIQUE_CHECKS = 1;\nSET FOREIGN_KEY_CHECKS = 1;\nCOMMIT;\n",
);

export function matchesBackupFilename(
    filename: string,
    prefix: string,
    extensions: string[] = [".sql", ".sql.gz"],
): boolean {
    if (!prefix) {
        return extensions.some((ext) => filename.endsWith(ext));
    }
    return backupFilenamePattern(prefix, extensions).test(filename);
}

/**
 * Lists all daily and monthly backups, optionally matching a filename prefix.
 * Sorted chronologically descending (newest first).
 */
export async function listBackups(
    storage: StorageAdapter,
    prefix = "",
    folders: { daily?: string; monthly?: string } = {},
    extensions: string[] = [".sql", ".sql.gz"],
): Promise<BackupFileEntry[]> {
    const dailyFolder = assertSafePathSegment(folders.daily ?? "daily", "Daily folder");
    const monthlyFolder = assertSafePathSegment(folders.monthly ?? "monthly", "Monthly folder");

    const [dailyList, monthlyList] = await Promise.all([
        storage.list(`${dailyFolder}/`),
        storage.list(`${monthlyFolder}/`),
    ]);

    const filterAndMap = (keys: string[], folder: string): BackupFileEntry[] => {
        return keys
            .filter((k) => {
                const filename = k.startsWith(`${folder}/`) ? k.slice(folder.length + 1) : k;
                return !filename.includes("/") && matchesBackupFilename(filename, prefix, extensions);
            })
            .sort()
            .reverse()
            .map((k) => {
                const filename = k.startsWith(`${folder}/`) ? k.slice(folder.length + 1) : k;
                return {
                    key: k,
                    folder,
                    filename,
                    isGzip: filename.endsWith(".gz"),
                };
            });
    };

    return [...filterAndMap(dailyList, dailyFolder), ...filterAndMap(monthlyList, monthlyFolder)];
}

/**
 * Lists root-level (non-rolling) backups matching the prefix and extensions.
 * Sorted chronologically descending (newest first).
 */
export async function listRootBackups(
    storage: StorageAdapter,
    prefix = "",
    extensions: string[] = [".sql", ".sql.gz"],
): Promise<BackupFileEntry[]> {
    const entries = await storage.list(prefix);
    return entries
        .filter((k) => !k.includes("/") && matchesBackupFilename(k, prefix, extensions))
        .sort()
        .reverse()
        .map((k) => ({
            key: k,
            folder: "root",
            filename: k,
            isGzip: k.endsWith(".gz"),
        }));
}

/**
 * Finds the latest backup key matching the prefix in the specified folder.
 */
export async function findLatestBackup(
    storage: StorageAdapter,
    folder = "daily",
    prefix = "",
    extensions: string[] = [".sql", ".sql.gz"],
): Promise<string | undefined> {
    const safeFolder = assertSafePathSegment(folder, "Backup folder");
    const list = await storage.list(`${safeFolder}/`);
    const matching = list
        .filter((k) => {
            const filename = k.startsWith(`${safeFolder}/`) ? k.slice(safeFolder.length + 1) : k;
            return !filename.includes("/") && matchesBackupFilename(filename, prefix, extensions);
        })
        .sort()
        .reverse();

    return matching[0];
}

/**
 * Detects gzip compression, decompresses if necessary, and wraps the SQL with
 * MySQL bulk performance optimizations (foreign keys / unique checks disabled, autocommit deferred).
 */
export function prepareRestoreSql(rawBytes: Uint8Array, dialect: DatabaseDialect = "mysql"): Uint8Array {
    const isGzip = rawBytes.length >= 2 && rawBytes[0] === 0x1f && rawBytes[1] === 0x8b;
    const sqlBytes = isGzip ? Bun.gunzipSync(Buffer.from(rawBytes)) : rawBytes;

    if (dialect === "pg") return sqlBytes;

    const totalLength = MYSQL_RESTORE_HEADER.length + sqlBytes.length + MYSQL_RESTORE_FOOTER.length;
    const result = new Uint8Array(totalLength);
    result.set(MYSQL_RESTORE_HEADER, 0);
    result.set(sqlBytes, MYSQL_RESTORE_HEADER.length);
    result.set(MYSQL_RESTORE_FOOTER, MYSQL_RESTORE_HEADER.length + sqlBytes.length);

    return result;
}

/**
 * Streaming equivalent of `prepareRestoreSql`: inspects the first two bytes for gzip magic,
 * decompresses on the fly when compressed, and wraps MySQL streams with header/footer statements.
 */
export function prepareRestoreSqlStream(
    rawStream: ReadableStream<Uint8Array>,
    dialect: DatabaseDialect = "mysql",
): ReadableStream<Uint8Array> {
    const output = new PassThrough();

    (async () => {
        const reader = rawStream.getReader();
        const peekChunks: Uint8Array[] = [];
        let peekBytes = 0;

        try {
            while (peekBytes < 2) {
                const { done, value } = await reader.read();
                if (done) break;
                if (value && value.byteLength > 0) {
                    peekChunks.push(value);
                    peekBytes += value.byteLength;
                }
            }

            const firstTwo = new Uint8Array(Math.min(2, peekBytes));
            let copied = 0;
            for (const c of peekChunks) {
                for (let i = 0; i < c.length && copied < 2; i++) {
                    firstTwo[copied++] = c[i] ?? 0;
                }
            }
            const isGzip = copied === 2 && firstTwo[0] === 0x1f && firstTwo[1] === 0x8b;

            if (dialect === "mysql") {
                output.write(MYSQL_RESTORE_HEADER);
            }

            if (isGzip) {
                const gunzip = createGunzip();
                const gunzipDone = new Promise<void>((resolve, reject) => {
                    gunzip.on("data", (chunk: Buffer) => {
                        if (!output.write(chunk)) {
                            gunzip.pause();
                            output.once("drain", () => gunzip.resume());
                        }
                    });
                    gunzip.once("end", resolve);
                    gunzip.once("error", reject);
                });

                for (const c of peekChunks) {
                    if (!gunzip.write(c)) await new Promise<void>((r) => gunzip.once("drain", r));
                }
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    if (value && value.byteLength > 0) {
                        if (!gunzip.write(value)) await new Promise<void>((r) => gunzip.once("drain", r));
                    }
                }
                gunzip.end();
                await gunzipDone;
            } else {
                for (const c of peekChunks) {
                    if (!output.write(c)) await new Promise<void>((r) => output.once("drain", r));
                }
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    if (value && value.byteLength > 0) {
                        if (!output.write(value)) await new Promise<void>((r) => output.once("drain", r));
                    }
                }
            }

            if (dialect === "mysql") {
                output.write(MYSQL_RESTORE_FOOTER);
            }
            output.end();
        } catch (err) {
            output.destroy(err instanceof Error ? err : new Error(String(err)));
        } finally {
            reader.releaseLock();
        }
    })();

    return Readable.toWeb(output) as unknown as ReadableStream<Uint8Array>;
}

/** Execute the selected native importer; input already has any backend-specific preparation. */
export async function executeRestore(opts: RestoreExecutionOptions): Promise<void> {
    const plan = buildRestoreCommand(opts.targetDb, opts.container);
    if (opts.sqlStream) {
        await streamDatabaseRestore(plan, opts.sqlStream);
        return;
    }
    if (opts.sqlData) {
        await runDatabaseCommand(plan, opts.sqlData);
        return;
    }
    throw new Error("executeRestore requires either sqlStream or sqlData.");
}
