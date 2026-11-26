import { expect, it } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPrivateFile, writePrivateFile } from "../src/files";

it("writes private backups atomically and preserves an existing backup on failure", async () => {
    const dir = await mkdtemp(join(tmpdir(), "opsync-files-"));
    const file = join(dir, "backup.sql");
    try {
        await writePrivateFile(file, "complete");
        expect((await stat(file)).mode & 0o777).toBe(0o600);
        await expect(createPrivateFile(file, async temp => { await Bun.write(temp, "partial"); throw new Error("write failed"); })).rejects.toThrow("write failed");
        expect(await readFile(file, "utf8")).toBe("complete");
    } finally { await rm(dir, { recursive: true, force: true }); }
});
