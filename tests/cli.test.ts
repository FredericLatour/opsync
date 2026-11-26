import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { version } from "../package.json";

const entry = join(import.meta.dir, "../src/cli.ts");

async function cli(args: string[], files: Record<string, string> = {}) {
    const dir = await mkdtemp(join(tmpdir(), "opsync-cli-"));
    try {
        for (const [name, data] of Object.entries(files)) {
            const fullPath = join(dir, name);
            await mkdir(join(fullPath, ".."), { recursive: true });
            await Bun.write(fullPath, data);
        }
        const p = Bun.spawn([process.execPath, entry, ...args], {
            cwd: dir,
            env: { ...process.env, HOME: dir },
            stdout: "pipe",
            stderr: "pipe",
            stdin: "ignore",
        });
        const [out, err, code] = await Promise.all([
            new Response(p.stdout).text(),
            new Response(p.stderr).text(),
            p.exited,
        ]);
        return { out, err, code };
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
}

describe("CLI startup", () => {
    it("shows version and nested help without reading a configuration", async () => {
        expect(await cli(["--version"])).toEqual({ out: `${version}\n`, err: "", code: 0 });
        const result = await cli(["db", "dump-import", "--help"]);
        expect(result.code).toBe(0);
        expect(result.out).toContain("--source-container");

        const n8nFolderHelp = await cli(["n8n", "backup-folder", "--help"]);
        expect(n8nFolderHelp.code).toBe(0);
        expect(n8nFolderHelp.out).toContain("--dir");

        const n8nRestoreFolderHelp = await cli(["n8n", "restore-folder", "--help"]);
        expect(n8nRestoreFolderHelp.code).toBe(0);
        expect(n8nRestoreFolderHelp.out).toContain("--dir");
    });

    it("reports missing explicit configuration cleanly", async () => {
        const result = await cli(["--config", "missing.toml", "db", "backup-folder", "test"]);
        expect(result.code).toBe(1);
        expect(result.err).toContain("Configuration not found");
    });

    it("keeps malformed secret values out of parse diagnostics", async () => {
        const result = await cli(["--config", "broken.toml", "db", "backup-folder", "test"], {
            "broken.toml": 'password = "private-fixture-value',
        });
        expect(result.code).toBe(1);
        expect(result.err).not.toContain("private-fixture-value");
    });

    it("accepts n8n-only configuration and validates restore scopes", async () => {
        const result = await cli(["--config", "n8n.toml", "n8n", "restore-s3", "--only", "typo"], {
            "n8n.toml": "[backup_n8n]\n",
        });
        expect(result.code).toBe(1);
        expect(result.err).toContain("Allowed choices");
    });

    it("validates n8n restore-s3 flags before resolving Docker containers", async () => {
        const result = await cli(["--config", "n8n.toml", "n8n", "restore-s3"], {
            "n8n.toml": `[s3.prod]
accessKeyId = "k"
secretAccessKey = "s"
endpoint = "https://s3.example.com"
region = "us-east-1"
bucket = "b"

[backup_n8n]
s3 = "prod"
`,
        });
        expect(result.code).toBe(1);
        expect(result.out).toBe("");
        expect(result.err).toContain("--latest, --file <key>, or --list");
    });

    it("supports n8n restore-folder --list in json and text formats", async () => {
        const result = await cli(
            ["--config", "n8n.toml", "n8n", "restore-folder", "--dir", "./backups", "--list", "--format=json"],
            {
                "n8n.toml": "[backup_n8n]\n",
                "backups/daily/n8n_2026_10_01_00_00_00.tar.gz": "fixture",
                "backups/daily/n8n_staging_2026_10_02_00_00_00.tar.gz": "fixture",
            },
        );
        expect(result.code).toBe(0);
        const listed = JSON.parse(result.out);
        expect(listed).toEqual([
            {
                key: "daily/n8n_2026_10_01_00_00_00.tar.gz",
                folder: "daily",
                filename: "n8n_2026_10_01_00_00_00.tar.gz",
                isGzip: true,
            },
        ]);
    });

    it("keeps --format=json stdout parseable and isolates sibling prefixes", async () => {
        const result = await cli(
            ["--config", "test.toml", "db", "restore-folder", "test", "--dir", "./backups", "--list", "--format=json"],
            {
                "test.toml": '[db.test]\nhost="localhost"\nport=3306\nuser="test"\npassword=""\ndatabase="app"\n',
                "backups/daily/app_2026_10_01_00_00_00.sql.gz": "fixture",
                "backups/daily/app_staging_2026_10_02_00_00_00.sql.gz": "fixture",
            },
        );
        expect(result.code).toBe(0);
        expect(JSON.parse(result.out)).toEqual([
            {
                key: "daily/app_2026_10_01_00_00_00.sql.gz",
                folder: "daily",
                filename: "app_2026_10_01_00_00_00.sql.gz",
                isGzip: true,
            },
        ]);
    });

    it("exits nonzero when non-interactive confirmation is missing --yes", async () => {
        const result = await cli(
            ["--config", "test.toml", "db", "restore-folder", "test", "--file", "./sample.sql"],
            {
                "test.toml": '[db.test]\nhost="localhost"\nport=3306\nuser="test"\npassword=""\ndatabase="app"\n',
                "sample.sql": "SELECT 1;\n",
            },
        );
        expect(result.code).toBe(1);
        expect(result.err).toContain("--yes");
    });

    it("writes missing-flag usage errors to stderr, keeping stdout empty", async () => {
        const result = await cli(
            ["--config", "test.toml", "db", "restore-folder", "test", "--dir", "./empty", "--format=json"],
            {
                "test.toml": '[db.test]\nhost="localhost"\nport=3306\nuser="test"\npassword=""\ndatabase="app"\n',
            },
        );
        expect(result.code).toBe(1);
        expect(result.out).toBe("");
        expect(result.err).toContain("--latest");
    });
});
