import { describe, expect, it } from "bun:test";
import {
    formatDuration,
    formatSource,
    formatBackupReport,
    formatRestoreReport,
    report,
    reportRestore,
    formatN8nBackupReport,
    formatN8nRestoreReport,
    reportN8n,
    reportN8nRestore,
} from "../src/reporter";

describe("formatDuration", () => {
    it("formats milliseconds (< 1s) as ms", () => {
        expect(formatDuration(0)).toBe("0ms");
        expect(formatDuration(450)).toBe("450ms");
        expect(formatDuration(999)).toBe("999ms");
    });

    it("formats seconds (< 60s) with 1 decimal place", () => {
        expect(formatDuration(1000)).toBe("1.0s");
        expect(formatDuration(4528)).toBe("4.5s");
        expect(formatDuration(59900)).toBe("59.9s");
    });

    it("formats minutes and rounded seconds (>= 60s)", () => {
        expect(formatDuration(60000)).toBe("1m 0s");
        expect(formatDuration(65400)).toBe("1m 5s");
        expect(formatDuration(125000)).toBe("2m 5s");
        expect(formatDuration(3665000)).toBe("61m 5s");
    });
});

describe("formatSource", () => {
    it("wraps folder and filename in backticks when path contains slashes", () => {
        expect(formatSource("daily/no_activity_log_2026_09_20.sql")).toBe("folder `daily`, file `no_activity_log_2026_09_20.sql`");
        expect(formatSource("no_activity_log_2026_09_20.sql")).toBe("`no_activity_log_2026_09_20.sql`");
    });

    it("wraps S3 label, folder and filename from S3 or local description in backticks", () => {
        expect(formatSource("S3 [prod] (daily/no_activity_log_2026_09_20.sql)")).toBe("S3 [`prod`] folder `daily`, file `no_activity_log_2026_09_20.sql`");
        expect(formatSource("Local file (/tmp/no_activity_log.sql)")).toBe("Local file `/tmp/no_activity_log.sql`");
        expect(formatSource("Folder (/backups/daily/no_activity_log.sql.gz)")).toBe("folder `/backups/daily`, file `no_activity_log.sql.gz`");
    });

    it("separates and backticks folder and filename from backticked paths", () => {
        expect(formatSource("S3 [prod] `daily/no_activity_log_2026_09_20.sql`")).toBe("S3 [`prod`] folder `daily`, file `no_activity_log_2026_09_20.sql`");
        expect(formatSource("Folder `/backups/no_activity_log.sql`")).toBe("folder `/backups`, file `no_activity_log.sql`");
        expect(formatSource("S3 [`prod`] folder `daily`, file `no_activity_log.sql`")).toBe("S3 [`prod`] folder `daily`, file `no_activity_log.sql`");
    });
});

describe("formatBackupReport", () => {
    it("formats success backup report in markdown with backticks and double spaces for line breaks", () => {
        const reportText = formatBackupReport({
            status: "success",
            dbLabel: "prod",
            database: "no_activity_log",
            s3Label: "my_s3",
            mode: "full",
            gzip: true,
            rolling: false,
            outputFile: "daily/no_activity_log_2026_09_20.sql.gz",
            deletedDaily: [],
            deletedMonthly: [],
            durationMs: 4500,
        });

        expect(reportText).toContain("✅ **mysqldump** `no_activity_log` (full mode, gzip) → S3 [`my_s3`]  ");
        expect(reportText).toContain("- **Duration**: 4.5s  ");
        expect(reportText).toContain("- **Output**: `daily/no_activity_log_2026_09_20.sql.gz`  ");
        // Verify every line ends with double space for markdown line break
        const lines = reportText.trimStart().split("\n");
        for (const line of lines) {
            expect(line.endsWith("  ")).toBe(true);
        }
    });

    it("formats local folder destination with backticks when destFolder is provided", () => {
        const reportText = formatBackupReport({
            status: "success",
            dbLabel: "local",
            database: "app_db",
            destFolder: "./dbsync/backup",
            mode: "schema",
            gzip: false,
            rolling: false,
            outputFile: "/tmp/app_db.sql",
            deletedDaily: [],
            deletedMonthly: [],
            durationMs: 200,
        });

        expect(reportText).toContain("✅ **mysqldump** `app_db` (schema mode) → folder `./dbsync/backup`  ");
        expect(reportText).toContain("- **Duration**: 200ms  ");
        expect(reportText).toContain("- **Output**: `/tmp/app_db.sql`  ");
    });

    it("formats rolling backup details with monthly and deleted files ending in double spaces", () => {
        const reportText = formatBackupReport({
            status: "success",
            dbLabel: "prod",
            database: "analytics_data",
            s3Label: "wasabi",
            mode: "full",
            gzip: true,
            rolling: true,
            outputFile: "daily/analytics_data_2026_09_20.sql.gz",
            monthlyCreated: "monthly/analytics_data_2026_09_01.sql.gz",
            deletedDaily: [
                "daily/analytics_data_2026_09_10.sql.gz",
                "daily/analytics_data_2026_09_11.sql.gz",
            ],
            deletedMonthly: [
                "monthly/analytics_data_2026_07_01.sql.gz",
            ],
            durationMs: 65000,
        });

        expect(reportText).toContain("- **Monthly**: `monthly/analytics_data_2026_09_01.sql.gz` (created)  ");
        expect(reportText).toContain("🗑️  **Deleted daily files** (2):  ");
        expect(reportText).toContain("- `daily/analytics_data_2026_09_10.sql.gz`  ");
        expect(reportText).toContain("- `daily/analytics_data_2026_09_11.sql.gz`  ");
        expect(reportText).toContain("🗑️  **Deleted monthly files** (1):  ");
        expect(reportText).toContain("- `monthly/analytics_data_2026_07_01.sql.gz`  ");
    });

    it("formats error backup report with icon, error bullet, and double spaces", () => {
        const reportText = formatBackupReport({
            status: "error",
            dbLabel: "prod",
            database: "app_db",
            mode: "full",
            gzip: false,
            rolling: false,
            outputFile: "/tmp/dbsync",
            deletedDaily: [],
            deletedMonthly: [],
            durationMs: 150,
            error: "mysqldump: Got error: 1045 Access denied",
        });

        expect(reportText).toContain("❌ **mysqldump** `app_db` (full mode) → local folder  ");
        expect(reportText).toContain("- **Duration**: 150ms  ");
        expect(reportText).toContain("- **Output**: `/tmp/dbsync`  ");
        expect(reportText).toContain("- **Error**: mysqldump: Got error: 1045 Access denied  ");
    });
});

describe("formatRestoreReport", () => {
    it("formats successful restore report with backticks on folders/files and double spaces for line breaks", () => {
        const reportText = formatRestoreReport({
            status: "success",
            targetEnv: "prod",
            database: "no_activity_log",
            source: "S3 [backup] (daily/no_activity_log_2026_09_20.sql.gz)",
            sizeMb: 12.34,
            durationMs: 1250,
        });

        expect(reportText).toContain("✅ **mysql** restore `no_activity_log`  ");
        expect(reportText).toContain("- **Duration**: 1.3s  ");
        expect(reportText).toContain("- **Source**: S3 [`backup`] folder `daily`, file `no_activity_log_2026_09_20.sql.gz`  ");
        expect(reportText).toContain("- **Size**: 12.34 MB  ");

        // Verify every line has double space for line break in markdown
        const lines = reportText.trimStart().split("\n");
        for (const line of lines) {
            expect(line.endsWith("  ")).toBe(true);
        }
    });

    it("omits size line when sizeMb is undefined and preserves double spaces", () => {
        const reportText = formatRestoreReport({
            status: "success",
            targetEnv: "local",
            database: "test_db",
            source: "Folder `/backups/test_db.sql`",
            durationMs: 800,
        });

        expect(reportText).toContain("✅ **mysql** restore `test_db`  ");
        expect(reportText).toContain("- **Duration**: 800ms  ");
        expect(reportText).toContain("- **Source**: folder `/backups`, file `test_db.sql`  ");
        expect(reportText).not.toContain("- **Size**");
    });

    it("formats failed restore report in markdown with error detail and double spaces", () => {
        const reportText = formatRestoreReport({
            status: "error",
            targetEnv: "prod",
            database: "no_activity_log",
            source: "S3 [prod] `daily/no_activity_log_2026_09_20.sql.gz`",
            durationMs: 500,
            error: "ERROR 1050 (42S01): Table 'users' already exists",
        });

        expect(reportText).toContain("❌ **mysql** restore `no_activity_log` failed  ");
        expect(reportText).toContain("- **Duration**: 500ms  ");
        expect(reportText).toContain("- **Source**: S3 [`prod`] folder `daily`, file `no_activity_log_2026_09_20.sql.gz`  ");
        expect(reportText).toContain("- **Error**: ERROR 1050 (42S01): Table 'users' already exists  ");
    });
});

describe("report & reportRestore console output", () => {
    it("outputs JSON when format is 'json' in report", () => {
        const logs: string[] = [];
        const originalLog = console.log;
        console.log = (msg: string) => { logs.push(msg); };

        try {
            report({
                status: "success",
                dbLabel: "prod",
                database: "my_db",
                mode: "full",
                rolling: false,
                outputFile: "file.sql",
                deletedDaily: [],
                deletedMonthly: [],
                durationMs: 100,
            }, "json");

            expect(logs.length).toBe(1);
            const parsed = JSON.parse(logs[0] ?? "");
            expect(parsed.database).toBe("my_db");
            expect(parsed.status).toBe("success");
        } finally {
            console.log = originalLog;
        }
    });

    it("outputs markdown when format is 'markdown' or 'text'", () => {
        const logs: string[] = [];
        const originalLog = console.log;
        console.log = (msg: string) => { logs.push(msg); };

        try {
            report({
                status: "success",
                dbLabel: "prod",
                database: "no_activity_log",
                mode: "full",
                rolling: false,
                outputFile: "daily/no_activity_log.sql",
                deletedDaily: [],
                deletedMonthly: [],
                durationMs: 100,
            }, "markdown");

            expect(logs.length).toBe(1);
            expect(logs[0]).toContain("✅ **mysqldump** `no_activity_log`");
            expect(logs[0]).toContain("- **Output**: `daily/no_activity_log.sql`");
        } finally {
            console.log = originalLog;
        }
    });

    it("outputs JSON when format is 'json' in reportRestore", () => {
        const logs: string[] = [];
        const originalLog = console.log;
        console.log = (msg: string) => { logs.push(msg); };

        try {
            reportRestore({
                status: "success",
                targetEnv: "prod",
                database: "my_db",
                source: "file.sql",
                durationMs: 200,
            }, "json");

            expect(logs.length).toBe(1);
            const parsed = JSON.parse(logs[0] ?? "");
            expect(parsed.database).toBe("my_db");
            expect(parsed.status).toBe("success");
        } finally {
            console.log = originalLog;
        }
    });

    it("outputs markdown to console.error when restore fails", () => {
        const errors: string[] = [];
        const originalError = console.error;
        console.error = (msg: string) => { errors.push(msg); };

        try {
            reportRestore({
                status: "error",
                targetEnv: "prod",
                database: "my_db",
                source: "file.sql",
                durationMs: 200,
                error: "fail reason",
            }, "markdown");

            expect(errors.length).toBe(1);
            expect(errors[0]).toContain("❌ **mysql** restore `my_db` failed");
            expect(errors[0]).toContain("- **Error**: fail reason");
        } finally {
            console.error = originalError;
        }
    });

    it("outputs n8n backup report in json and markdown", () => {
        const logs: string[] = [];
        const originalLog = console.log;
        console.log = (msg: string) => { logs.push(msg); };

        try {
            reportN8n({
                status: "success",
                service: "n8n",
                container: "n8n-local",
                s3Label: "prod",
                rolling: true,
                gzip: true,
                outputFile: "daily/n8n_prod_2026_09_22.tar.gz",
                workflowsCount: 10,
                credentialsCount: 4,
                decrypted: false,
                monthlyCreated: "monthly/n8n_prod_2026_09.tar.gz",
                deletedDaily: ["daily/n8n_prod_2026_09_01.tar.gz"],
                deletedMonthly: [],
                durationMs: 1200,
            }, "markdown");

            expect(logs.length).toBe(1);
            expect(logs[0]).toContain("✅ **n8n** backup `n8n-local` (10 workflows, 4 credentials, encrypted, gzip) → S3 [`prod`]");
            expect(logs[0]).toContain("- **Monthly**: `monthly/n8n_prod_2026_09.tar.gz` (created)");
            expect(logs[0]).toContain("🗑️  **Deleted daily files** (1):");
        } finally {
            console.log = originalLog;
        }
    });

    it("outputs n8n restore report in markdown", () => {
        const logs: string[] = [];
        const originalLog = console.log;
        console.log = (msg: string) => { logs.push(msg); };

        try {
            reportN8nRestore({
                status: "success",
                service: "n8n",
                container: "n8n-local",
                source: "S3 [prod] folder `daily`, file `n8n_prod_2026_09_22.tar.gz`",
                workflowsCount: 10,
                credentialsCount: 4,
                durationMs: 800,
            }, "markdown");

            expect(logs.length).toBe(1);
            expect(logs[0]).toContain("✅ **n8n** restore `n8n-local` (10 workflows, 4 credentials)");
            expect(logs[0]).toContain("- **Duration**: 800ms");
        } finally {
            console.log = originalLog;
        }
    });

    it("formatN8nBackupReport formats decrypted and uncompressed correctly", () => {
        const text = formatN8nBackupReport({
            status: "success",
            service: "n8n",
            container: "n8n-custom",
            s3Label: "archive",
            rolling: false,
            gzip: false,
            decrypted: true,
            outputFile: "backup.tar",
            workflowsCount: 5,
            credentialsCount: 2,
            deletedDaily: [],
            deletedMonthly: [],
            durationMs: 500,
        });

        expect(text).toContain("✅ **n8n** backup `n8n-custom` (5 workflows, 2 credentials, decrypted, uncompressed) → S3 [`archive`]");
        expect(text).toContain("- **Output**: `backup.tar`");
    });

    it("formatN8nBackupReport supports destFolder and plain text format without markdown markers", () => {
        const plain = formatN8nBackupReport(
            {
                status: "success",
                service: "n8n",
                container: "n8n-local",
                destFolder: "/backups/n8n",
                rolling: false,
                gzip: true,
                decrypted: false,
                outputFile: "/backups/n8n/n8n_2026_10_01.tar.gz",
                workflowsCount: 3,
                credentialsCount: 1,
                deletedDaily: [],
                deletedMonthly: [],
                durationMs: 250,
            },
            "text",
        );

        expect(plain).toContain("✅ n8n backup n8n-local (3 workflows, 1 credentials, encrypted, gzip) → folder /backups/n8n");
        expect(plain).toContain("- Output: /backups/n8n/n8n_2026_10_01.tar.gz");
        expect(plain).not.toContain("**");
        expect(plain).not.toContain("`");
        for (const line of plain.trimStart().split("\n")) {
            expect(line.endsWith("  ")).toBe(false);
        }
    });

    it("formatN8nRestoreReport formats failure with error details", () => {
        const text = formatN8nRestoreReport({
            status: "error",
            service: "n8n",
            container: "n8n-local",
            source: "daily/backup.tar.gz",
            durationMs: 120,
            error: "Container unreachable",
        });

        expect(text).toContain("❌ **n8n** restore `n8n-local` failed");
        expect(text).toContain("- **Error**: Container unreachable");
    });
});



