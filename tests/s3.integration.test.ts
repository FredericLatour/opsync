import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { S3Config } from "../src/config";
import { findLatestBackup } from "../src/db/restorer";
import { applyRolling } from "../src/rolling";
import { S3Storage } from "../src/storage";
import { s3Fixture } from "./helpers/s3";

const scope = `integration/${crypto.randomUUID()}`;
let storage: S3Storage;
let directory: string;

function requireFixture(): S3Config {
    if (!s3Fixture) throw new Error("S3 integration fixture is not configured");
    return s3Fixture;
}

async function batches<T>(items: T[], action: (item: T) => Promise<unknown>) {
    for (let start = 0; start < items.length; start += 16) {
        // Wait for every request before cleanup, including when one fails.
        const results = await Promise.allSettled(items.slice(start, start + 16).map(action));
        for (const result of results) if (result.status === "rejected") throw result.reason;
    }
}

describe.skipIf(!s3Fixture)("Garage S3 integration", () => {
    beforeAll(async () => {
        storage = new S3Storage(requireFixture(), scope);
        directory = await mkdtemp(join(tmpdir(), "opsync-s3-"));
    });

    afterAll(async () => {
        try {
            if (storage) await batches(await storage.list(""), (key) => storage.delete(key));
        } finally {
            if (directory) await rm(directory, { recursive: true, force: true });
        }
    }, 60000);

    it("round-trips gzip bytes and unusual object names, then deletes them", async () => {
        const fixture = requireFixture();
        const key = "roundtrip/space + café/backup.sql.gz";
        const payload = Bun.gzipSync(new TextEncoder().encode("SELECT 'fixture';\n"));
        await storage.put(key, payload);
        // Both supported spellings of the storage prefix address the same object.
        const reader = new S3Storage(fixture, `${scope}/`);
        expect(await reader.get(key)).toEqual(payload);
        expect(await reader.list("roundtrip/")).toEqual([key]);
        await storage.delete(key);
        expect(await storage.list("roundtrip/")).toEqual([]);
        await expect(storage.get(key)).rejects.toThrow();
    });

    it("round-trips an upload larger than two 5 MiB multipart chunks", async () => {
        const fixture = requireFixture();
        const payload = randomBytes(11 * 1024 * 1024 + 37);
        await storage.put("multipart/large.sql", payload);
        const metadata = await new Bun.S3Client(fixture).file(`${scope}/multipart/large.sql`).stat();
        // Garage's multipart ETag records the number of uploaded parts.
        expect(metadata.etag).toMatch(/-3"?$/);
        const downloaded = await storage.get("multipart/large.sql");
        expect(downloaded.length).toBe(payload.length);
        expect(Buffer.from(downloaded).equals(payload)).toBe(true);
    });

    it("lists more than 1,000 objects and finds a backup beyond the first page", async () => {
        const fixture = requireFixture();
        const keys = Array.from({ length: 1001 }, (_, index) => `pagination/app_${2000 + index}_01_01_00_00_00.sql`);
        await batches(keys, (key) => storage.put(key, new Uint8Array([42])));
        const firstPage = await new Bun.S3Client(fixture).list({ prefix: `${scope}/pagination/`, maxKeys: 1000 });
        expect(firstPage.isTruncated).toBe(true);
        expect(firstPage.contents?.length).toBe(1000);
        expect(firstPage.nextContinuationToken).toBeTruthy();
        expect((await storage.list("pagination/")).sort()).toEqual(keys);
        expect(await findLatestBackup(storage, "pagination", "app_")).toBe(keys.at(-1));
    }, 60000);

    it("prunes daily and monthly objects without deleting another profile's backups", async () => {
        const fixture = requireFixture();
        const retained = new S3Storage(fixture, `${scope}/retention`);
        const olderDaily = "daily/app_2000_01_01_00_00_00.sql.gz";
        const olderMonthly = "monthly/app_2000_01.sql.gz";
        const unrelated = "daily/app_other_2000_01_01_00_00_00.sql.gz";
        const unrelatedMonth = "monthly/app_other_2000_01.sql.gz";
        const payload = Bun.gzipSync(new TextEncoder().encode("original backup"));
        for (const key of [olderDaily, olderMonthly, unrelated, unrelatedMonth]) await retained.put(key, payload);
        const localPath = join(directory, "dump.sql.gz");
        await Bun.write(localPath, payload);
        const options = {
            storage: retained,
            localPath,
            prefix: "app_",
            keepLast: 1,
            keepMonths: 1,
            filename: "app_2001_01_01_00_00_00.sql.gz",
        };
        const result = await applyRolling(options);
        expect(result.deletedDaily).toEqual([olderDaily]);
        expect(result.deletedMonthly).toEqual([olderMonthly]);
        expect(result.monthlyCreated).toBeTruthy();
        const monthlyKey = result.monthlyCreated ?? "";
        expect((await retained.list("daily/")).sort()).toEqual([result.dailyKey, unrelated].sort());
        expect((await retained.list("monthly/")).sort()).toEqual([monthlyKey, unrelatedMonth].sort());
        expect(await retained.get(result.dailyKey)).toEqual(payload);
        await expect(retained.get(olderDaily)).rejects.toThrow();
        await expect(retained.get(olderMonthly)).rejects.toThrow();
        await Bun.write(localPath, Bun.gzipSync(new TextEncoder().encode("second backup")));
        expect((await applyRolling(options)).monthlyCreated).toBeUndefined();
        expect(await retained.get(monthlyKey)).toEqual(payload);
    });

    it("rejects a request signed with the wrong secret instead of returning an empty listing", async () => {
        const fixture = requireFixture();
        const invalid = new S3Storage({ ...fixture, secretAccessKey: "invalid-fixture-secret" }, scope);
        await expect(findLatestBackup(invalid, "daily", "app_")).rejects.toThrow();
    });
});
