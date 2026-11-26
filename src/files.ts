import { createReadStream, createWriteStream } from "node:fs";
import { chmod, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export function hasControlCharacters(value: string): boolean {
    for (let i = 0; i < value.length; i++) {
        const code = value.charCodeAt(i);
        if (code < 0x20 || code === 0x7f) return true;
    }
    return false;
}

export function assertSafePathSegment(value: string, label: string): string {
    if (!value || value.includes("/") || value.includes("\\") || hasControlCharacters(value) || value === "." || value === "..") {
        throw new Error(`${label} must be a nonempty filename, without path separators or control characters`);
    }
    return value;
}

/** Build in a private directory, then rename so readers never see partial backups. */
export async function createPrivateFile(path: string, create: (temporary: string) => Promise<void>): Promise<void> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const staging = await mkdtemp(join(dirname(path), ".opsync-write-"));
    try {
        const temporary = join(staging, "payload");
        await create(temporary);
        await chmod(temporary, 0o600);
        await rename(temporary, path);
    } finally {
        await rm(staging, { recursive: true, force: true });
    }
}

export async function writePrivateFile(path: string, content: string | Uint8Array): Promise<void> {
    await createPrivateFile(path, (temporary) => writeFile(temporary, content, { mode: 0o600 }));
}

export async function copyPrivateFile(sourcePath: string, destinationPath: string): Promise<void> {
    await createPrivateFile(destinationPath, async (temporary) => {
        await pipeline(createReadStream(sourcePath), createWriteStream(temporary, { mode: 0o600 }));
    });
}

export async function writePrivateStream(path: string, stream: ReadableStream<Uint8Array>): Promise<void> {
    await createPrivateFile(path, async (temporary) => {
        const nodeReadable = Readable.fromWeb(stream as unknown as import("node:stream/web").ReadableStream);
        await pipeline(nodeReadable, createWriteStream(temporary, { mode: 0o600 }));
    });
}
