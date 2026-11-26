import { describe, expect, it } from "bun:test";
import { DbConfigSchema } from "../src/config";
import { buildDumpCommand, buildRestoreCommand, runDatabaseCommand, transferDatabase } from "../src/db/client";
import { prepareRestoreSql } from "../src/db/restorer";

const connection = {
    host: "127.0.0.1",
    port: "5432",
    user: "fixture",
    password: "fixture-password",
    database: "fixture",
};

describe("database profile and native script contracts", () => {
    it("keeps legacy MySQL profiles and unrelated tool fields compatible", () => {
        const db = DbConfigSchema.parse({ ...connection, adapter: "harlequin" });
        expect(db.dialect).toBe("mysql");
        expect(db.port).toBe(5432);
        expect(db.adapter).toBe("harlequin");
        expect(buildDumpCommand(db, { mode: "schema" }).argv[0]).toBe("mysqldump");
        expect(buildRestoreCommand(db).argv[0]).toBe("mysql");
    });

    it("rejects an explicit unknown dialect rather than silently treating it as MySQL", () => {
        expect(DbConfigSchema.safeParse({ ...connection, dialect: "postgrez" }).success).toBe(false);
    });

    it("preserves native PostgreSQL script bytes after decompression", () => {
        const sql = "\\restrict TestKey\nCOPY fixture FROM stdin;\n1\tDEFINER=unchanged\n\\.\n\\unrestrict TestKey\n";
        expect(new TextDecoder().decode(prepareRestoreSql(Bun.gzipSync(sql), "pg"))).toBe(sql);
    });

    it("uses PostgreSQL clients and keeps the password out of their argv", () => {
        const db = DbConfigSchema.parse({ ...connection, dialect: "pg" });
        const plan = buildDumpCommand(db, { mode: "full", container: "fixture-pg", tables: ["public.MixedCase"] });
        expect(plan.argv).toContain("pg_dump");
        expect(plan.argv).toContain('"public"."MixedCase"');
        expect(plan.argv).not.toContain(connection.password);
        expect(plan.env.PGPASSWORD).toBe(connection.password);
        expect(buildRestoreCommand(db).argv).toContain("--set=ON_ERROR_STOP=1");
    });

    it("fails a mixed-engine transfer before opening either endpoint", async () => {
        const mysql = DbConfigSchema.parse(connection);
        const pg = DbConfigSchema.parse({ ...connection, dialect: "pg" });
        await expect(transferDatabase(mysql, pg, ["fixture"])).rejects.toThrow("same dialect");
    });

    it("reports missing clients without revealing their arguments", async () => {
        await expect(
            runDatabaseCommand({
                argv: ["/definitely-not-an-opsync-client", connection.password],
                env: process.env,
                password: connection.password,
                label: "fixture client",
            }),
        ).rejects.toThrow("Cannot start fixture client");
    });

    it("reports a native process failure with secret values redacted", async () => {
        await expect(
            runDatabaseCommand({
                argv: [process.execPath, "-e", "process.stderr.write(process.env.FIXTURE_SECRET);process.exit(7)"],
                env: { ...process.env, FIXTURE_SECRET: connection.password },
                password: connection.password,
                label: "fixture client",
            }),
        ).rejects.toThrow("fixture client exited with code 7:\n[redacted]");
    });
});

it("keeps MySQL secrets out of argv, avoids password prompts, enables --hex-blob, and honors TCP ports", () => {
    for (const password of ["", "secret with spaces"]) {
        const db = DbConfigSchema.parse({ ...connection, password, container: "mysql-custom" });
        const plan = buildDumpCommand(db, { mode: "full" });
        expect(plan.argv).toContain("mysql-custom");
        expect(plan.argv).toContain("--protocol=TCP");
        expect(plan.argv).toContain("--hex-blob");
        expect(plan.argv).not.toContain(`-p${password}`);
        expect(plan.env.MYSQL_PWD).toBe(password);
        expect(buildRestoreCommand(db, "override").argv).toContain("override");
    }
});
