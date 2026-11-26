import { mkdir, mkdtemp, rm, unlink } from "node:fs/promises";
import { join } from "node:path";
import { type Command, Option } from "commander";
import { buildPrefix, type DumpMode, dumpDatabase } from "../../db/dumper";
import { type BackupResult, type OutputFormat, report } from "../../reporter";
import { applyRolling } from "../../rolling";
import { LocalStorage, putFileToStorage, S3Storage } from "../../storage";
import { ensureDbConfig, getCliContext, requireS3Profile } from "../context";

export function registerDbBackupCommands(dbCmd: Command): void {
    dbCmd
        .command("backup-s3")
        .description("Backup a database directly to S3-compatible storage (with optional rolling retention)")
        .argument("<db-label>", "Database config label (from TOML [db.<label>])")
        .addOption(new Option("--mode <mode>", "What to dump").choices(["full", "schema", "data"]).default("full"))
        .option("--database <name>", "Override the database name from the config [Optional, fallback: [db.<label>].database]")
        .option("--file-prefix <prefix>", "Override the export filename prefix [Optional, fallback: <database>_ or table list]")
        .option(
            "--table, --tables <tables...>",
            "Only dump these tables — accepts space- or comma-separated list, or repeatable --table flag (also used as filename prefix unless --file-prefix is set) [Optional]",
        )
        .option(
            "--ignore-table, --ignore-tables <tables...>",
            "Exclude tables — accepts space- or comma-separated list, or repeatable --ignore-table flag [Optional, additive with [backup_s3].ignore_tables]",
        )
        .option("--s3 <label>", "S3 config profile label [Required if not in TOML: [backup_s3].s3]")
        .option("--s3-prefix <path>", "Key prefix within the S3 bucket (e.g. 'mysql/prod/') [Optional, fallback: [backup_s3].prefix]")
        .option("--tmp-dir <path>", "Local temporary staging directory [Optional, fallback: [backup_s3].tmp_dir]")
        .option("-c, --container <name>", "Run the native dump client via docker exec in this container [Optional]")
        .option("--no-gzip", "Do not compress the backup with gzip (uncompressed .sql)")
        .option("--rolling", "Enable daily/monthly rolling retention policy [Optional flag, default: false]", false)
        .addOption(new Option("--format <format>", "Output reporting format").choices(["markdown", "json", "text"]).default("markdown"))
        .addHelpText(
            "after",
            `
Examples:
  # Baseline: One-shot full backup of 'prod' uploaded directly to S3 configured in [backup_s3].s3 (gzipped by default):
  $ opsync db backup-s3 prod

  # Without compression (uncompressed .sql):
  $ opsync db backup-s3 prod --no-gzip

  # Using a container:
  $ opsync db backup-s3 dev -c mysql8

  # Specific tables:
  $ opsync db backup-s3 prod --tables users orders

  # Exclude tables:
  $ opsync db backup-s3 prod --ignore-tables logs sessions

  # Custom file prefix:
  $ opsync db backup-s3 prod --file-prefix snapshot

  # Custom S3 profile:
  $ opsync db backup-s3 prod --s3 archive

  # Rolling retention:
  $ opsync db backup-s3 prod --rolling

  # Structured JSON output:
  $ opsync db backup-s3 prod --format json
`,
        )
        .action(
            async (
                dbLabel: string,
                opts: {
                    mode: DumpMode;
                    database?: string;
                    filePrefix?: string;
                    tables?: string[];
                    ignoreTables?: string[];
                    s3?: string;
                    s3Prefix?: string;
                    tmpDir?: string;
                    container?: string;
                    gzip: boolean;
                    rolling: boolean;
                    format: OutputFormat;
                },
            ) => {
                const start = Date.now();
                const ctx = getCliContext();
                const db = ensureDbConfig(ctx, dbLabel);
                const s3CfgSection = ctx.settings.backup_s3;
                const rollingCfg = ctx.settings.rolling;

                const { label: effectiveS3Label, config: s3Cfg } = requireS3Profile(
                    ctx,
                    opts.s3 ?? s3CfgSection.s3,
                    "'s3' in [backup_s3]",
                );

                const s3Prefix = opts.s3Prefix ?? s3CfgSection.prefix;
                const tmpDir = opts.tmpDir ?? s3CfgSection.tmp_dir;
                const { gzip, rolling } = opts;
                const ignoreTables = [...(s3CfgSection.ignore_tables ?? []), ...(opts.ignoreTables ?? [])];

                const effectiveDb = opts.database ? { ...db, database: opts.database } : db;
                const prefix = buildPrefix({
                    filePrefix: opts.filePrefix,
                    tables: opts.tables,
                    database: effectiveDb.database,
                });

                const storage = new S3Storage(s3Cfg, s3Prefix);

                let dumpResult: Awaited<ReturnType<typeof dumpDatabase>>;
                try {
                    dumpResult = await dumpDatabase({
                        db: effectiveDb,
                        mode: opts.mode,
                        tables: opts.tables,
                        ignoreTables,
                        localDir: tmpDir,
                        prefix,
                        container: opts.container,
                        gzip,
                    });
                } catch (err) {
                    const res: BackupResult = {
                        ...(db.dialect === "pg" ? { dialect: "pg" as const } : {}),
                        status: "error",
                        dbLabel,
                        database: effectiveDb.database,
                        s3Label: effectiveS3Label,
                        mode: opts.mode,
                        gzip,
                        rolling,
                        outputFile: tmpDir,
                        deletedDaily: [],
                        deletedMonthly: [],
                        durationMs: Date.now() - start,
                        error: String(err),
                    };
                    report(res, opts.format);
                    process.exit(1);
                }

                try {
                    if (!rolling) {
                        await putFileToStorage(storage, dumpResult.filename, dumpResult.finalPath);

                        const res: BackupResult = {
                            ...(db.dialect === "pg" ? { dialect: "pg" as const } : {}),
                            status: "success",
                            dbLabel,
                            database: effectiveDb.database,
                            s3Label: effectiveS3Label,
                            mode: opts.mode,
                            gzip,
                            rolling: false,
                            outputFile: dumpResult.filename,
                            deletedDaily: [],
                            deletedMonthly: [],
                            durationMs: Date.now() - start,
                        };
                        report(res, opts.format);
                        return;
                    }

                    const rollingResult = await applyRolling({
                        prefix,
                        keepLast: rollingCfg.keep_last,
                        keepMonths: rollingCfg.keep_months,
                        dailyFolder: rollingCfg.daily,
                        monthlyFolder: rollingCfg.monthly,
                        storage,
                        localPath: dumpResult.finalPath,
                        filename: dumpResult.filename,
                    });

                    const res: BackupResult = {
                        ...(db.dialect === "pg" ? { dialect: "pg" as const } : {}),
                        status: "success",
                        dbLabel,
                        database: effectiveDb.database,
                        s3Label: effectiveS3Label,
                        mode: opts.mode,
                        gzip,
                        rolling: true,
                        outputFile: rollingResult.dailyKey,
                        monthlyCreated: rollingResult.monthlyCreated,
                        deletedDaily: rollingResult.deletedDaily,
                        deletedMonthly: rollingResult.deletedMonthly,
                        durationMs: Date.now() - start,
                    };
                    report(res, opts.format);
                } catch (err) {
                    const res: BackupResult = {
                        ...(db.dialect === "pg" ? { dialect: "pg" as const } : {}),
                        status: "error",
                        dbLabel,
                        database: effectiveDb.database,
                        s3Label: effectiveS3Label,
                        mode: opts.mode,
                        gzip,
                        rolling,
                        outputFile: dumpResult.finalPath,
                        deletedDaily: [],
                        deletedMonthly: [],
                        durationMs: Date.now() - start,
                        error: String(err),
                    };
                    report(res, opts.format);
                    process.exitCode = 1;
                } finally {
                    await unlink(dumpResult.finalPath).catch(() => {});
                }
            },
        );

    dbCmd
        .command("backup-folder")
        .description("Backup a database to a local or mounted filesystem directory (with optional rolling retention)")
        .argument("<db-label>", "Database config label (from TOML [db.<label>])")
        .addOption(new Option("--mode <mode>", "What to dump").choices(["full", "schema", "data"]).default("full"))
        .option("--database <name>", "Override the database name from the config [Optional, fallback: [db.<label>].database]")
        .option("--file-prefix <prefix>", "Override the export filename prefix [Optional, fallback: <database>_ or table list]")
        .option(
            "--table, --tables <tables...>",
            "Only dump these tables — accepts space- or comma-separated list, or repeatable --table flag (also used as filename prefix unless --file-prefix is set) [Optional]",
        )
        .option(
            "--ignore-table, --ignore-tables <tables...>",
            "Exclude tables — accepts space- or comma-separated list, or repeatable --ignore-table flag [Optional, additive with [backup_folder].ignore_tables]",
        )
        .option("--dir <path>", "Destination directory [Required if not in TOML: [backup_folder].dir]")
        .option("-c, --container <name>", "Run the native dump client via docker exec in this container [Optional]")
        .option("--no-gzip", "Do not compress the backup with gzip (uncompressed .sql)")
        .option("--rolling", "Enable daily/monthly rolling retention policy [Optional flag, default: false]", false)
        .addOption(new Option("--format <format>", "Output reporting format").choices(["markdown", "json", "text"]).default("markdown"))
        .addHelpText(
            "after",
            `
Examples:
  # Baseline: One-shot full backup of 'prod' written directly to [backup_folder].dir (gzipped by default):
  $ opsync db backup-folder prod

  # Without compression:
  $ opsync db backup-folder prod --no-gzip

  # Using a container:
  $ opsync db backup-folder dev -c mysql8

  # Specific tables:
  $ opsync db backup-folder prod --tables users orders

  # Exclude tables:
  $ opsync db backup-folder prod --ignore-tables logs sessions

  # Custom file prefix:
  $ opsync db backup-folder prod --file-prefix snapshot

  # Custom directory:
  $ opsync db backup-folder prod --dir /mnt/backups

  # Rolling retention:
  $ opsync db backup-folder prod --rolling

  # Structured JSON output:
  $ opsync db backup-folder prod --format json
`,
        )
        .action(
            async (
                dbLabel: string,
                opts: {
                    mode: DumpMode;
                    database?: string;
                    filePrefix?: string;
                    tables?: string[];
                    ignoreTables?: string[];
                    dir?: string;
                    container?: string;
                    gzip: boolean;
                    rolling: boolean;
                    format: OutputFormat;
                },
            ) => {
                const start = Date.now();
                const ctx = getCliContext();
                const db = ensureDbConfig(ctx, dbLabel);
                const folderCfgSection = ctx.settings.backup_folder;
                const rollingCfg = ctx.settings.rolling;

                const destDir = opts.dir ?? folderCfgSection.dir;
                if (!destDir) {
                    console.error("❌ Error: No destination folder specified.");
                    console.error(
                        `Please provide --dir <path> or define 'dir' in [backup_folder] in your ${ctx.configDisplayName}.`,
                    );
                    process.exit(1);
                }

                const { gzip, rolling } = opts;
                const ignoreTables = [...(folderCfgSection.ignore_tables ?? []), ...(opts.ignoreTables ?? [])];

                const effectiveDb = opts.database ? { ...db, database: opts.database } : db;
                const prefix = buildPrefix({
                    filePrefix: opts.filePrefix,
                    tables: opts.tables,
                    database: effectiveDb.database,
                });

                if (!rolling) {
                    let dumpResult: Awaited<ReturnType<typeof dumpDatabase>>;
                    try {
                        dumpResult = await dumpDatabase({
                            db: effectiveDb,
                            mode: opts.mode,
                            tables: opts.tables,
                            ignoreTables,
                            localDir: destDir,
                            prefix,
                            container: opts.container,
                            gzip,
                        });
                    } catch (err) {
                        report(
                            {
                                ...(db.dialect === "pg" ? { dialect: "pg" as const } : {}),
                                status: "error",
                                dbLabel,
                                database: effectiveDb.database,
                                destFolder: destDir,
                                mode: opts.mode,
                                gzip,
                                rolling: false,
                                outputFile: destDir,
                                deletedDaily: [],
                                deletedMonthly: [],
                                durationMs: Date.now() - start,
                                error: String(err),
                            },
                            opts.format,
                        );
                        process.exit(1);
                    }

                    report(
                        {
                            ...(db.dialect === "pg" ? { dialect: "pg" as const } : {}),
                            status: "success",
                            dbLabel,
                            database: effectiveDb.database,
                            destFolder: destDir,
                            mode: opts.mode,
                            gzip,
                            rolling: false,
                            outputFile: dumpResult.finalPath,
                            deletedDaily: [],
                            deletedMonthly: [],
                            durationMs: Date.now() - start,
                        },
                        opts.format,
                    );
                    return;
                }

                // Stage rolling dumps inside a private hidden directory so partial or failed runs
                // never leave orphan files visible at the root of destDir.
                await mkdir(destDir, { recursive: true, mode: 0o700 });
                const stagingDir = await mkdtemp(join(destDir, ".opsync-stage-"));
                try {
                    const dumpResult = await dumpDatabase({
                        db: effectiveDb,
                        mode: opts.mode,
                        tables: opts.tables,
                        ignoreTables,
                        localDir: stagingDir,
                        prefix,
                        container: opts.container,
                        gzip,
                    });

                    const storage = new LocalStorage(destDir);
                    const rollingResult = await applyRolling({
                        prefix,
                        keepLast: rollingCfg.keep_last,
                        keepMonths: rollingCfg.keep_months,
                        dailyFolder: rollingCfg.daily,
                        monthlyFolder: rollingCfg.monthly,
                        storage,
                        localPath: dumpResult.finalPath,
                        filename: dumpResult.filename,
                    });

                    report(
                        {
                            ...(db.dialect === "pg" ? { dialect: "pg" as const } : {}),
                            status: "success",
                            dbLabel,
                            database: effectiveDb.database,
                            destFolder: destDir,
                            mode: opts.mode,
                            gzip,
                            rolling: true,
                            outputFile: `${destDir}/${rollingResult.dailyKey}`,
                            monthlyCreated: rollingResult.monthlyCreated
                                ? `${destDir}/${rollingResult.monthlyCreated}`
                                : undefined,
                            deletedDaily: rollingResult.deletedDaily.map((k) => `${destDir}/${k}`),
                            deletedMonthly: rollingResult.deletedMonthly.map((k) => `${destDir}/${k}`),
                            durationMs: Date.now() - start,
                        },
                        opts.format,
                    );
                } catch (err) {
                    report(
                        {
                            ...(db.dialect === "pg" ? { dialect: "pg" as const } : {}),
                            status: "error",
                            dbLabel,
                            database: effectiveDb.database,
                            destFolder: destDir,
                            mode: opts.mode,
                            gzip,
                            rolling: true,
                            outputFile: destDir,
                            deletedDaily: [],
                            deletedMonthly: [],
                            durationMs: Date.now() - start,
                            error: String(err),
                        },
                        opts.format,
                    );
                    process.exitCode = 1;
                } finally {
                    await rm(stagingDir, { recursive: true, force: true });
                }
            },
        );
}
