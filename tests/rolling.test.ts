import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { applyRolling } from "../src/rolling";
import { LocalStorage } from "../src/storage";

const TEST_DIR = join(process.cwd(), "test-rolling-storage");
const STAGING_DIR = join(process.cwd(), "test-rolling-staging");

beforeEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
    await rm(STAGING_DIR, { recursive: true, force: true });
});

afterEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
    await rm(STAGING_DIR, { recursive: true, force: true });
});

describe("applyRolling", () => {
    it("carries over uncompressed .sql file to daily and monthly without gzipping", async () => {
        const storage = new LocalStorage(TEST_DIR);
        const localPath = join(STAGING_DIR, "test_2026_09_10_12_00_00.sql");
        const rawContent = "CREATE TABLE users (id int);";
        await Bun.write(localPath, rawContent);

        const result = await applyRolling({
            prefix: "test_",
            keepLast: 5,
            keepMonths: 3,
            storage,
            localPath,
            filename: "test_2026_09_10_12_00_00.sql",
        });

        expect(result.dailyKey).toBe("daily/test_2026_09_10_12_00_00.sql");
        expect(result.monthlyCreated).toMatch(/^monthly\/test_\d{4}_\d{2}\.sql$/);

        // Daily file content must match raw bytes
        const dailyBytes = await storage.get(result.dailyKey);
        expect(new TextDecoder().decode(dailyBytes)).toBe(rawContent);

        // Monthly file content must match raw bytes (NOT gzipped)
        if (result.monthlyCreated) {
            const monthlyBytes = await storage.get(result.monthlyCreated);
            expect(new TextDecoder().decode(monthlyBytes)).toBe(rawContent);
        }
    });

    it("carries over gzipped .sql.gz file to daily and monthly without re-compressing", async () => {
        const storage = new LocalStorage(TEST_DIR);
        const localPath = join(STAGING_DIR, "test_2026_09_10_12_00_00.sql.gz");
        const rawContent = "CREATE TABLE products (id int);";
        const gzipped = Bun.gzipSync(rawContent);
        await Bun.write(localPath, gzipped);

        const result = await applyRolling({
            prefix: "test_",
            keepLast: 5,
            keepMonths: 3,
            storage,
            localPath,
            filename: "test_2026_09_10_12_00_00.sql.gz",
        });

        expect(result.dailyKey).toBe("daily/test_2026_09_10_12_00_00.sql.gz");
        expect(result.monthlyCreated).toMatch(/^monthly\/test_\d{4}_\d{2}\.sql\.gz$/);

        // Daily file content must match original gzipped bytes
        const dailyBytes = await storage.get(result.dailyKey);
        expect(new TextDecoder().decode(Bun.gunzipSync(Buffer.from(dailyBytes)))).toBe(rawContent);
        expect(dailyBytes.byteLength).toBe(gzipped.byteLength);

        // Monthly file content must match original gzipped bytes (not double-compressed)
        if (result.monthlyCreated) {
            const monthlyBytes = await storage.get(result.monthlyCreated);
            expect(new TextDecoder().decode(Bun.gunzipSync(Buffer.from(monthlyBytes)))).toBe(rawContent);
            expect(monthlyBytes.byteLength).toBe(gzipped.byteLength);
        }
    });

    it("does not create duplicate monthly backup if one already exists for the month", async () => {
        const storage = new LocalStorage(TEST_DIR);
        const file1 = join(STAGING_DIR, "test_2026_09_10_12_00_00.sql");
        const file2 = join(STAGING_DIR, "test_2026_09_10_13_00_00.sql.gz");
        await Bun.write(file1, "dump 1");
        await Bun.write(file2, Bun.gzipSync("dump 2"));

        const res1 = await applyRolling({
            prefix: "test_",
            keepLast: 5,
            keepMonths: 3,
            storage,
            localPath: file1,
            filename: "test_2026_09_10_12_00_00.sql",
        });
        expect(res1.monthlyCreated).toBeDefined();

        const res2 = await applyRolling({
            prefix: "test_",
            keepLast: 5,
            keepMonths: 3,
            storage,
            localPath: file2,
            filename: "test_2026_09_10_13_00_00.sql.gz",
        });
        expect(res2.monthlyCreated).toBeUndefined();
    });

    it("prunes older daily backups exceeding keepLast", async () => {
        const storage = new LocalStorage(TEST_DIR);
        await storage.mkdir("daily");
        await storage.put("daily/test_2026_09_01_00_00_00.sql", new Uint8Array([1]));
        await storage.put("daily/test_2026_09_02_00_00_00.sql.gz", new Uint8Array([2]));

        const localPath = join(STAGING_DIR, "test_2026_09_03_00_00_00.sql.gz");
        await Bun.write(localPath, new Uint8Array([3]));

        const result = await applyRolling({
            prefix: "test_",
            keepLast: 2,
            keepMonths: 0,
            storage,
            localPath,
            filename: "test_2026_09_03_00_00_00.sql.gz",
        });

        expect(result.deletedDaily).toEqual(["daily/test_2026_09_01_00_00_00.sql"]);
        const remaining = await storage.list("daily/");
        expect(remaining).toContain("daily/test_2026_09_02_00_00_00.sql.gz");
        expect(remaining).toContain("daily/test_2026_09_03_00_00_00.sql.gz");
        expect(remaining).not.toContain("daily/test_2026_09_01_00_00_00.sql");
    });

    it("respects custom dailyFolder and monthlyFolder names", async () => {
        const storage = new LocalStorage(TEST_DIR);
        const localPath = join(STAGING_DIR, "test_2026_09_10_12_00_00.sql");
        await Bun.write(localPath, "test content");

        const result = await applyRolling({
            prefix: "test_",
            keepLast: 5,
            keepMonths: 3,
            storage,
            localPath,
            filename: "test_2026_09_10_12_00_00.sql",
            dailyFolder: "my_daily",
            monthlyFolder: "my_monthly",
        });

        expect(result.dailyKey).toBe("my_daily/test_2026_09_10_12_00_00.sql");
        expect(result.monthlyCreated).toMatch(/^my_monthly\/test_\d{4}_\d{2}\.sql$/);

        const dailyList = await storage.list("my_daily/");
        expect(dailyList).toContain("my_daily/test_2026_09_10_12_00_00.sql");
    });

    it("carries over .tar.gz archive preserving .tar.gz extension in monthly", async () => {
        const storage = new LocalStorage(TEST_DIR);
        const localPath = join(STAGING_DIR, "n8n_prod_2026_09_10_12_00_00.tar.gz");
        const rawContent = "mock tar.gz content";
        await Bun.write(localPath, rawContent);

        const result = await applyRolling({
            prefix: "n8n_prod_",
            keepLast: 5,
            keepMonths: 3,
            storage,
            localPath,
            filename: "n8n_prod_2026_09_10_12_00_00.tar.gz",
        });

        expect(result.dailyKey).toBe("daily/n8n_prod_2026_09_10_12_00_00.tar.gz");
        expect(result.monthlyCreated).toMatch(/^monthly\/n8n_prod_\d{4}_\d{2}\.tar\.gz$/);
    });
});

describe("LocalStorage.list", () => {
    it("handles prefix queries with directories and file prefixes", async () => {
        const storage = new LocalStorage(TEST_DIR);
        await storage.mkdir("monthly");
        await storage.put("monthly/app_2026_08.sql.gz", new Uint8Array([1]));
        await storage.put("monthly/app_2026_09.sql", new Uint8Array([2]));
        await storage.put("monthly/other_2026_09.sql", new Uint8Array([3]));

        const matches = await storage.list("monthly/app_2026_09");
        expect(matches).toEqual(["monthly/app_2026_09.sql"]);

        const allApp = await storage.list("monthly/app_");
        expect(allApp.sort()).toEqual(["monthly/app_2026_08.sql.gz", "monthly/app_2026_09.sql"]);
    });
});

it("does not prune a longer profile prefix or unrelated files", async () => {
    const storage = new LocalStorage(TEST_DIR);
    await storage.mkdir("daily");
    await storage.put("daily/app_other_2026_09_01_00_00_00.sql", new Uint8Array([1]));
    await storage.put("daily/app_notes.txt", new Uint8Array([1]));
    await storage.put("daily/app_2026_09_01_00_00_00.sql", new Uint8Array([1]));
    const localPath = join(STAGING_DIR, "app_2026_09_02_00_00_00.sql");
    await Bun.write(localPath, "fixture");
    const result = await applyRolling({ storage, prefix: "app_", keepLast: 1, keepMonths: 0, localPath, filename: "app_2026_09_02_00_00_00.sql" });
    expect(result.deletedDaily).toEqual(["daily/app_2026_09_01_00_00_00.sql"]);
    expect(await storage.list("daily/")).toContain("daily/app_notes.txt");
    expect(await storage.list("daily/")).toContain("daily/app_other_2026_09_01_00_00_00.sql");
});
