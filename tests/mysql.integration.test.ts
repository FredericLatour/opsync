import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DbConfigSchema } from "../src/config";
import { buildRestoreCommand, runDatabaseCommand, transferDatabase } from "../src/db/client";
import { dumpDatabase } from "../src/db/dumper";
import { executeRestore, prepareRestoreSql } from "../src/db/restorer";

const container = process.env.OPSYNC_MYSQL_TEST_CONTAINER;
const tag = `opsync_test_${crypto.randomUUID().replaceAll("-", "")}`;
const profile = (database: string) => DbConfigSchema.parse({ host: "127.0.0.1", port: 3306, user: "root", password: "opsync-fixture-only", database, container });
const source = profile(`${tag}_src`);
const target = profile(`${tag}_dst`);
let dir: string;
async function query(db: typeof source, sql: string) {
    const plan = buildRestoreCommand(db);
    plan.argv.push("-N", "-B");
    return new TextDecoder().decode(await runDatabaseCommand(plan, new TextEncoder().encode(sql))).trim();
}

describe.skipIf(!container)("MySQL native round trips (isolated fixture container)", () => {
    beforeAll(async () => {
        dir = await mkdtemp(join(tmpdir(), "opsync-mysql-"));
        await query(profile("mysql"), `CREATE DATABASE ${source.database}; CREATE DATABASE ${target.database};`);
        await query(source, [
            "CREATE TABLE items (id int PRIMARY KEY AUTO_INCREMENT, value text);",
            "INSERT INTO items(value) VALUES ('literal DEFINER=alice@localhost'), ('second');",
            "CREATE VIEW counts AS SELECT count(*) AS total FROM items;",
            "CREATE TABLE binary_keys (query_hash BINARY(8) PRIMARY KEY, payload BLOB);",
            "INSERT INTO binary_keys(query_hash, payload) VALUES (X'80FFFEC328EDA080', X'DEADBEEF00FF8081'), (X'91FEFFE228A18182', X'CAFEBABE00FE9091');",
        ].join(" "));
    });
    afterAll(async () => {
        await query(profile("mysql"), `DROP DATABASE IF EXISTS ${source.database}; DROP DATABASE IF EXISTS ${target.database};`);
        if (dir) await rm(dir, { recursive: true, force: true });
    });
    it("restores gzip dumps, views, binary primary keys, and literal DEFINER row values", async () => {
        const dump = await dumpDatabase({ db: source, mode: "full", gzip: true, localDir: dir, prefix: "fixture_" });
        await executeRestore({ targetDb: target, sqlData: prepareRestoreSql(await Bun.file(dump.finalPath).bytes()) });
        expect(await query(target, "SELECT value FROM items WHERE id=1")).toBe("literal DEFINER=alice@localhost");
        expect(await query(target, "SELECT total FROM counts")).toBe("2");
        expect(await query(target, "SELECT HEX(query_hash), HEX(payload) FROM binary_keys ORDER BY query_hash")).toBe(
            "80FFFEC328EDA080\tDEADBEEF00FF8081\n91FEFFE228A18182\tCAFEBABE00FE9091"
        );
    });
    it("transfers data through clients using per-profile container settings", async () => {
        await query(target, "DROP VIEW counts; DROP TABLE items;");
        await transferDatabase(source, target, ["items"]);
        expect(await query(target, "SELECT count(*) FROM items")).toBe("2");
    });
});
