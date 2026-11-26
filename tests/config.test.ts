import { afterEach, describe, expect, it } from "bun:test";
import { unlink } from "node:fs/promises";
import { join } from "node:path";
import { APP_CONFIG, getDefaultConfigPaths, loadSettings } from "../src/config";

const TEST_FILE = join(process.cwd(), "test-config.toml");

afterEach(async () => {
    try {
        await unlink(TEST_FILE);
    } catch {}
});

describe("loadSettings", () => {
    it("returns 'success' with valid content", async () => {
        await Bun.write(
            TEST_FILE,
            `[db.main]
host = "127.0.0.1"
port = 3306
user = "root"
password = "pwd"
database = "mydb"`,
        );

        const result = await loadSettings(TEST_FILE);

        expect(result.status).toBe("success");
        if (result.status !== "success") return;

        expect(result.path).toBe(TEST_FILE);

        const dbMain = result.data.db.main;
        expect(dbMain).toBeDefined();
        expect(dbMain).toEqual({
            dialect: "mysql",
            host: "127.0.0.1",
            port: 3306,
            user: "root",
            password: "pwd",
            database: "mydb",
        });
    });

    it("returns 'not_found' and lists candidates when file is missing", async () => {
        const result = await loadSettings("missing.toml");

        expect(result.status).toBe("not_found");
        if (result.status !== "not_found") return;

        expect(result.searchedPaths).toEqual(["missing.toml"]);
    });

    it("returns 'parse_error' for broken TOML syntax", async () => {
        await Bun.write(TEST_FILE, "[db.broken\nport = 5432");

        const result = await loadSettings(TEST_FILE);

        expect(result.status).toBe("parse_error");
        if (result.status !== "parse_error") return;

        expect(result.path).toBe(TEST_FILE);
        expect(result.error).toBeInstanceOf(Error);
    });

    it("returns 'validation_error' with detailed Zod issues for invalid field values", async () => {
        await Bun.write(
            TEST_FILE,
            `[db.main]
host = ""
port = 70000
user = "root"
password = "pwd"
database = ""`,
        );

        const result = await loadSettings(TEST_FILE);

        expect(result.status).toBe("validation_error");
        if (result.status !== "validation_error") return;

        expect(result.path).toBe(TEST_FILE);
        expect(result.issues.length).toBeGreaterThan(0);
    });

    it("allows an empty [db] table for n8n-only installations", async () => {
        await Bun.write(TEST_FILE, "[db]\n");

        const result = await loadSettings(TEST_FILE);

        expect(result.status).toBe("success");
    });

    it("defaults rolling, backup_folder, and backup_s3 when omitted", async () => {
        await Bun.write(
            TEST_FILE,
            `[db.main]
host = "127.0.0.1"
port = 3306
user = "root"
password = "pwd"
database = "mydb"`,
        );

        const result = await loadSettings(TEST_FILE);
        expect(result.status).toBe("success");
        if (result.status !== "success") return;

        expect(result.data.rolling).toEqual({
            keep_last: 15,
            keep_months: 12,
            daily: "daily",
            monthly: "monthly",
        });
        expect(result.data.backup_folder).toEqual({
            dir: undefined,
            ignore_tables: [],
        });
        expect(result.data.backup_s3).toEqual({
            s3: undefined,
            prefix: undefined,
            tmp_dir: APP_CONFIG.defaultTmpDir,
            ignore_tables: [],
        });
        expect(result.data.backup_n8n).toEqual({
            s3: undefined,
            dir: undefined,
            prefix: "n8n",
            tmp_dir: APP_CONFIG.defaultTmpDir,
            container: undefined,
        });
    });

    it("parses custom rolling, backup_folder, backup_s3, and backup_n8n configurations", async () => {
        await Bun.write(
            TEST_FILE,
            `[db.main]
host = "127.0.0.1"
port = 3306
user = "root"
password = "pwd"
database = "mydb"

[rolling]
keep_last = 7
keep_months = 6
daily = "custom_daily"
monthly = "custom_monthly"

[backup_folder]
dir = "/var/backups"
ignore_tables = ["sessions", "cache"]

[backup_s3]
s3 = "prod"
prefix = "mysql/prod"
tmp_dir = "/var/tmp"
ignore_tables = ["logs"]

[backup_n8n]
s3 = "prod"
dir = "/var/backups/n8n"
prefix = "n8n/prod"
tmp_dir = "/tmp/custom_n8n"
container = "my-n8n"`,
        );

        const result = await loadSettings(TEST_FILE);
        expect(result.status).toBe("success");
        if (result.status !== "success") return;

        expect(result.data.rolling).toEqual({
            keep_last: 7,
            keep_months: 6,
            daily: "custom_daily",
            monthly: "custom_monthly",
        });
        expect(result.data.backup_folder).toEqual({
            dir: "/var/backups",
            ignore_tables: ["sessions", "cache"],
        });
        expect(result.data.backup_s3).toEqual({
            s3: "prod",
            prefix: "mysql/prod",
            tmp_dir: "/var/tmp",
            ignore_tables: ["logs"],
        });
        expect(result.data.backup_n8n).toEqual({
            s3: "prod",
            dir: "/var/backups/n8n",
            prefix: "n8n/prod",
            tmp_dir: "/tmp/custom_n8n",
            container: "my-n8n",
        });
    });

    it("expands env placeholders, supports escaped dollar-brace literals, and reports missing variables", async () => {
        const dollarBrace = "${";
        await Bun.write(
            TEST_FILE,
            `[db.main]
host = "${dollarBrace}DB_HOST}"
port = 5432
dialect = "pg"
user = "backup"
password = "${dollarBrace}DB_PASS}-$${dollarBrace}LITERAL}"
database = "mydb"`,
        );

        const ok = await loadSettings(TEST_FILE, { DB_HOST: "db.internal", DB_PASS: "s3cr3t" });
        expect(ok.status).toBe("success");
        if (ok.status === "success") {
            expect(ok.data.db.main?.host).toBe("db.internal");
            expect(ok.data.db.main?.password).toBe(`s3cr3t-${dollarBrace}LITERAL}`);
        }

        const missing = await loadSettings(TEST_FILE, { DB_HOST: "db.internal" });
        expect(missing.status).toBe("validation_error");
        if (missing.status === "validation_error") {
            expect(missing.issues[0]?.message).toContain("DB_PASS");
            expect(missing.issues[0]?.path).toEqual(["db", "main", "password"]);
        }
    });

    it("falls back to standard AWS_* environment variables for S3 profiles", async () => {
        await Bun.write(
            TEST_FILE,
            `[s3.ci]
bucket = "my-backups"`,
        );

        const result = await loadSettings(TEST_FILE, {
            AWS_ACCESS_KEY_ID: "AKIA_TEST",
            AWS_SECRET_ACCESS_KEY: "SECRET_TEST",
            AWS_SESSION_TOKEN: "TOKEN_TEST",
            AWS_REGION: "eu-west-1",
            S3_ENDPOINT: "https://s3.eu-west-1.amazonaws.com",
        });

        expect(result.status).toBe("success");
        if (result.status !== "success") return;
        expect(result.data.s3.ci).toEqual({
            accessKeyId: "AKIA_TEST",
            secretAccessKey: "SECRET_TEST",
            sessionToken: "TOKEN_TEST",
            region: "eu-west-1",
            endpoint: "https://s3.eu-west-1.amazonaws.com",
            bucket: "my-backups",
        });
    });

    it("rejects rolling folder names containing path traversal or slashes", async () => {
        await Bun.write(
            TEST_FILE,
            `[rolling]
daily = "../escape"`,
        );

        const result = await loadSettings(TEST_FILE);
        expect(result.status).toBe("validation_error");
    });

    it("searches only opsync config file candidates", () => {
        const paths = getDefaultConfigPaths();
        expect(paths).toContain(join(process.cwd(), APP_CONFIG.dotConfigFileName));
        expect(paths).toContain(join(process.cwd(), APP_CONFIG.configFileName));
        expect(paths).toHaveLength(4);
    });
});
