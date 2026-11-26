import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import {
    findLatestBackup,
    listBackups,
    listRootBackups,
    prepareRestoreSql,
    prepareRestoreSqlStream,
} from "../src/db/restorer";
import { LocalStorage } from "../src/storage";

const TEST_DIR = join(process.cwd(), "test-restorer-storage");

beforeEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
});

afterEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
});

async function streamFromBytes(bytes: Uint8Array, chunkSize = 1): Promise<ReadableStream<Uint8Array>> {
    return new ReadableStream<Uint8Array>({
        start(controller) {
            for (let i = 0; i < bytes.length; i += chunkSize) {
                controller.enqueue(bytes.subarray(i, i + chunkSize));
            }
            controller.close();
        },
    });
}

describe("prepareRestoreSql & prepareRestoreSqlStream", () => {
    it("wraps uncompressed SQL with performance and autocommit headers/footers", () => {
        const sql = "INSERT INTO users VALUES (1, 'Alice');";
        const rawBytes = new TextEncoder().encode(sql);
        const prepared = prepareRestoreSql(rawBytes);
        const resultText = new TextDecoder().decode(prepared);

        expect(resultText).toContain("SET autocommit=0;");
        expect(resultText).toContain("SET FOREIGN_KEY_CHECKS = 0;");
        expect(resultText).toContain("SET UNIQUE_CHECKS = 0;");
        expect(resultText).toContain(sql);
        expect(resultText).toContain("SET UNIQUE_CHECKS = 1;");
        expect(resultText).toContain("SET FOREIGN_KEY_CHECKS = 1;");
        expect(resultText).toContain("COMMIT;");
    });

    it("decompresses gzipped SQL and wraps it with performance flags", () => {
        const sql = "CREATE TABLE orders (id INT, total DECIMAL(10,2));";
        const gzipped = Bun.gzipSync(sql);
        const prepared = prepareRestoreSql(gzipped);
        const resultText = new TextDecoder().decode(prepared);

        expect(resultText).toContain("SET autocommit=0;");
        expect(resultText).toContain(sql);
        expect(resultText).toContain("COMMIT;");
    });

    it("preserves raw non-UTF-8 binary bytes when wrapping uncompressed and gzipped MySQL dumps", () => {
        const enc = new TextEncoder();
        const binaryPayload = Buffer.concat([
            enc.encode("INSERT INTO `query` VALUES ('"),
            new Uint8Array([0x80, 0xff, 0xfe, 0xc3, 0x28, 0xed, 0xa0, 0x80]),
            enc.encode("');\n"),
        ]);

        for (const input of [new Uint8Array(binaryPayload), Bun.gzipSync(new Uint8Array(binaryPayload))]) {
            const prepared = Buffer.from(prepareRestoreSql(input, "mysql"));
            expect(prepared.includes(binaryPayload)).toBe(true);
            expect(prepared.includes(Buffer.from([0xef, 0xbf, 0xbd]))).toBe(false);
        }
    });

    it("streams uncompressed and gzipped MySQL and PostgreSQL dumps byte-for-byte identically to prepareRestoreSql", async () => {
        const enc = new TextEncoder();
        const payload = Buffer.concat([
            enc.encode("INSERT INTO `query` VALUES ('"),
            new Uint8Array([0x80, 0xff, 0xfe, 0xc3, 0x28]),
            enc.encode("');\n"),
        ]);
        const inputs = [new Uint8Array(payload), Bun.gzipSync(new Uint8Array(payload))];

        for (const dialect of ["mysql", "pg"] as const) {
            for (const input of inputs) {
                const expected = prepareRestoreSql(input, dialect);
                const stream = prepareRestoreSqlStream(await streamFromBytes(input, 1), dialect);
                const actual = new Uint8Array(await new Response(stream).arrayBuffer());
                expect(Buffer.from(actual).equals(Buffer.from(expected))).toBe(true);
            }
        }
    });
});

describe("listBackups and findLatestBackup", () => {
    it("filters by prefix and sorts chronologically descending", async () => {
        const storage = new LocalStorage(TEST_DIR);
        await storage.mkdir("daily");
        await storage.mkdir("monthly");

        await storage.put("daily/app_db_2026_09_10_02_00_00.sql", new Uint8Array([1]));
        await storage.put("daily/app_db_2026_09_15_02_00_00.sql.gz", new Uint8Array([2]));
        await storage.put("daily/app_db_2026_09_18_02_00_00.sql", new Uint8Array([3]));
        await storage.put("daily/billing_2026_09_19_02_00_00.sql", new Uint8Array([4]));
        await storage.put("monthly/app_db_2026_08.sql.gz", new Uint8Array([5]));
        await storage.put("monthly/billing_2026_08.sql", new Uint8Array([6]));

        const appBackups = await listBackups(storage, "app_db_");
        expect(appBackups.length).toBe(4);
        expect(appBackups[0]?.key).toBe("daily/app_db_2026_09_18_02_00_00.sql");
        expect(appBackups[0]?.isGzip).toBe(false);
        expect(appBackups[1]?.key).toBe("daily/app_db_2026_09_15_02_00_00.sql.gz");
        expect(appBackups[1]?.isGzip).toBe(true);
        expect(appBackups[3]?.key).toBe("monthly/app_db_2026_08.sql.gz");

        expect(await findLatestBackup(storage, "daily", "app_db_")).toBe("daily/app_db_2026_09_18_02_00_00.sql");
        expect(await findLatestBackup(storage, "daily", "billing_")).toBe("daily/billing_2026_09_19_02_00_00.sql");
        expect(await findLatestBackup(storage, "monthly", "app_db_")).toBe("monthly/app_db_2026_08.sql.gz");
        expect(await findLatestBackup(storage, "daily", "unknown_db_")).toBeUndefined();
    });

    it("does not collide with sibling prefixes like app_staging_ when querying app_", async () => {
        const storage = new LocalStorage(TEST_DIR);
        await storage.mkdir("daily");
        await storage.mkdir("monthly");

        await storage.put("app_2026_09_18_02_00_00.sql.gz", new Uint8Array([1]));
        await storage.put("app_staging_2026_09_19_02_00_00.sql.gz", new Uint8Array([2]));
        await storage.put("daily/app_2026_09_18_02_00_00.sql.gz", new Uint8Array([1]));
        await storage.put("daily/app_staging_2026_09_19_02_00_00.sql.gz", new Uint8Array([2]));
        await storage.put("monthly/app_2026_09.sql.gz", new Uint8Array([1]));
        await storage.put("monthly/app_staging_2026_09.sql.gz", new Uint8Array([2]));

        expect(await findLatestBackup(storage, "daily", "app_")).toBe("daily/app_2026_09_18_02_00_00.sql.gz");
        expect((await listBackups(storage, "app_")).map((b) => b.key)).toEqual([
            "daily/app_2026_09_18_02_00_00.sql.gz",
            "monthly/app_2026_09.sql.gz",
        ]);
        expect((await listRootBackups(storage, "app_")).map((b) => b.key)).toEqual([
            "app_2026_09_18_02_00_00.sql.gz",
        ]);
    });

    it("respects custom daily and monthly folder names", async () => {
        const storage = new LocalStorage(TEST_DIR);
        await storage.mkdir("my_daily");
        await storage.mkdir("my_monthly");

        await storage.put("my_daily/db_2026_09_18_02_00_00.sql", new Uint8Array([1]));
        await storage.put("my_monthly/db_2026_08.sql.gz", new Uint8Array([2]));

        const backups = await listBackups(storage, "db_", { daily: "my_daily", monthly: "my_monthly" });
        expect(backups.length).toBe(2);
        expect(backups[0]?.folder).toBe("my_daily");
        expect(backups[0]?.key).toBe("my_daily/db_2026_09_18_02_00_00.sql");
        expect(backups[1]?.folder).toBe("my_monthly");

        const latest = await findLatestBackup(storage, "my_daily", "db_");
        expect(latest).toBe("my_daily/db_2026_09_18_02_00_00.sql");
    });

    it("supports custom extensions such as .tar.gz and .tar for n8n backups", async () => {
        const storage = new LocalStorage(TEST_DIR);
        await storage.mkdir("daily");
        await storage.mkdir("monthly");

        await storage.put("daily/n8n_prod_2026_09_10.tar.gz", new Uint8Array([1]));
        await storage.put("daily/n8n_prod_2026_09_15.tar", new Uint8Array([2]));
        await storage.put("daily/db_2026_09_15.sql", new Uint8Array([3])); // should be ignored
        await storage.put("monthly/n8n_prod_2026_08.tar.gz", new Uint8Array([4]));

        const backups = await listBackups(storage, "n8n_prod_", {}, [".tar.gz", ".tar"]);
        expect(backups.length).toBe(3);
        expect(backups[0]?.key).toBe("daily/n8n_prod_2026_09_15.tar");
        expect(backups[0]?.isGzip).toBe(false);
        expect(backups[1]?.key).toBe("daily/n8n_prod_2026_09_10.tar.gz");
        expect(backups[1]?.isGzip).toBe(true);
        expect(backups[2]?.key).toBe("monthly/n8n_prod_2026_08.tar.gz");

        const latest = await findLatestBackup(storage, "daily", "n8n_prod_", [".tar.gz", ".tar"]);
        expect(latest).toBe("daily/n8n_prod_2026_09_15.tar");
    });

    it("supports LocalStorage.putFile and getStream round trips", async () => {
        const storage = new LocalStorage(TEST_DIR);
        const srcPath = join(TEST_DIR, "source.sql");
        await storage.mkdir("daily");
        await Bun.write(srcPath, "SELECT 42;\n");

        await storage.putFile("daily/app_2026_09_18_02_00_00.sql", srcPath);
        const { stream, sizeBytes } = await storage.getStream("daily/app_2026_09_18_02_00_00.sql");
        expect(sizeBytes).toBe(11);
        expect(await new Response(stream).text()).toBe("SELECT 42;\n");
    });
});
