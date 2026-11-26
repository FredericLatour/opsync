import { type Command, Option } from "commander";
import { APP_CONFIG } from "../../config";
import { executeRestore, prepareRestoreSqlStream } from "../../db/restorer";
import { type OutputFormat, reportRestore } from "../../reporter";
import { getStreamFromStorage, LocalStorage, S3Storage, type StorageReadStream } from "../../storage";
import { confirmAction, ensureDbConfig, getCliContext, requireS3Profile } from "../context";
import {
    collectBackups,
    formatLocalPathSource,
    formatStorageKeySource,
    printBackupList,
    resolveLatestBackupKey,
    resolveRestorePrefix,
} from "../shared";

const DB_EXTENSIONS = [".sql", ".sql.gz"];

export function registerDbRestoreCommands(dbCmd: Command): void {
    dbCmd
        .command("restore-s3")
        .description("Restore a database from S3-compatible backup storage")
        .argument("<target-env>", "Destination config keyword (from TOML [db.<label>])")
        .option("--s3 <label>", "S3 config profile label [Required if not in TOML: [backup_s3].s3]")
        .option("--s3-prefix <path>", "Key prefix within the S3 bucket [Optional, fallback: [backup_s3].prefix]")
        .option("--file-prefix <prefix>", "Override backup filename prefix filter [Optional, fallback: <database>_]")
        .option("--latest", "Automatically select the newest backup matching the prefix [Optional]")
        .option("--folder <folder>", "Folder tier to pick from when using --latest (e.g. 'daily' or 'monthly') [Optional, default: [rolling].daily]")
        .option("--file <key>", "Explicit backup S3 key to restore [Optional]")
        .option("--list", "List available backups in S3 matching the prefix and exit [Optional flag]")
        .option("--database <name>", "Override target database name on the destination server [Optional, fallback: [db.<label>].database]")
        .option("-c, --container <name>", "Run the native restore client via docker exec in this container [Optional]")
        .option("-y, --yes", "Skip interactive safety confirmation [Optional flag, recommended for cron/n8n]")
        .addOption(new Option("--format <format>", "Output reporting format").choices(["markdown", "json", "text"]).default("markdown"))
        .addHelpText(
            "after",
            `
Examples:
  # Restore 'local' database from the newest backup in S3:
  $ opsync db restore-s3 local --latest

  # Skip confirmation:
  $ opsync db restore-s3 local --latest -y

  # Using a container:
  $ opsync db restore-s3 local --latest -c mysql8

  # Specific S3 key:
  $ opsync db restore-s3 local --file daily/prod_2026_09_20_12_00_00.sql.gz

  # Custom file prefix:
  $ opsync db restore-s3 local --latest --file-prefix snapshot

  # Monthly archive:
  $ opsync db restore-s3 local --latest --folder monthly

  # List available backups:
  $ opsync db restore-s3 local --list

  # Structured JSON output:
  $ opsync db restore-s3 local --latest -y --format json
`,
        )
        .action(
            async (
                tgtEnv: string,
                opts: {
                    s3?: string;
                    s3Prefix?: string;
                    filePrefix?: string;
                    latest?: boolean;
                    folder?: string;
                    file?: string;
                    list?: boolean;
                    database?: string;
                    container?: string;
                    yes?: boolean;
                    format: OutputFormat;
                },
            ) => {
                const ctx = getCliContext();
                const rawTargetDb = ensureDbConfig(ctx, tgtEnv);
                const tgt = opts.database ? { ...rawTargetDb, database: opts.database } : rawTargetDb;

                const { label: effectiveS3Label, config: s3Cfg } = requireS3Profile(
                    ctx,
                    opts.s3 ?? ctx.settings.backup_s3.s3,
                    "'s3' in [backup_s3]",
                );

                const s3Prefix = opts.s3Prefix ?? ctx.settings.backup_s3.prefix;
                const storage = new S3Storage(s3Cfg, s3Prefix);

                const rollingCfg = ctx.settings.rolling;
                const prefix = resolveRestorePrefix(opts.filePrefix, tgt.database);

                if (opts.list) {
                    if (opts.format !== "json") {
                        console.log(`🔍 Searching backups with prefix '${prefix}' in S3 [${effectiveS3Label}]...`);
                    }
                    const allBackups = await collectBackups(
                        storage,
                        prefix,
                        { daily: rollingCfg.daily, monthly: rollingCfg.monthly },
                        DB_EXTENSIONS,
                    );
                    printBackupList(allBackups, {
                        format: opts.format,
                        prefix,
                        emptyNoun: "backups",
                        headingNoun: "backups",
                    });
                    return;
                }

                if (!opts.file && !opts.latest) {
                    console.error("❌ Error: You must specify --latest, --file <key>, or --list.");
                    console.error("Examples:");
                    console.error(`  opsync db restore-s3 ${tgtEnv} --latest`);
                    console.error(`  opsync db restore-s3 ${tgtEnv} --latest -y`);
                    console.error(`  opsync db restore-s3 ${tgtEnv} --list`);
                    process.exit(1);
                }

                let targetKey: string;
                if (opts.file) {
                    targetKey = opts.file;
                } else {
                    const latestKey = await resolveLatestBackupKey(
                        storage,
                        prefix,
                        { folder: opts.folder, dailyFolder: rollingCfg.daily },
                        DB_EXTENSIONS,
                    );
                    if (!latestKey) {
                        console.error(
                            `❌ Error: No backups found matching prefix '${prefix}' in S3 [${effectiveS3Label}].`,
                        );
                        console.error("Tip: Run with --list to view all available backups.");
                        process.exit(1);
                    }
                    targetKey = latestKey;
                }

                let sourceStream: StorageReadStream;
                try {
                    sourceStream = await getStreamFromStorage(storage, targetKey);
                } catch (err) {
                    console.error(
                        `❌ Error: Failed to retrieve backup '${targetKey}' from S3 [${effectiveS3Label}]: ${err}`,
                    );
                    process.exit(1);
                }

                const sourceDescription = formatStorageKeySource(targetKey, { s3Label: effectiveS3Label });
                const sizeMb =
                    sourceStream.sizeBytes !== undefined
                        ? (sourceStream.sizeBytes / (1024 * 1024)).toFixed(2)
                        : undefined;

                confirmAction(
                    "RESTORE Database from S3 (OVERWRITES TARGET DATA)",
                    [
                        `Target Engine: ${tgt.host}:${tgt.port} (${tgt.database})`,
                        `Container:     ${opts.container ?? tgt.container ?? "none (native database client)"}`,
                        `Source Backup: ${sourceDescription}`,
                        ...(sizeMb !== undefined ? [`Size:          ${sizeMb} MB`] : []),
                    ],
                    opts.yes,
                    opts.format === "json",
                );

                if (opts.format !== "json") {
                    console.log(`⏳ Streaming restore into ${tgt.database}...`);
                }
                const start = Date.now();

                try {
                    const preparedStream = prepareRestoreSqlStream(sourceStream.stream, tgt.dialect);
                    await executeRestore({
                        targetDb: tgt,
                        sqlStream: preparedStream,
                        localDir: ctx.settings.backup_s3.tmp_dir,
                        container: opts.container,
                    });
                } catch (err) {
                    reportRestore(
                        {
                            ...(tgt.dialect === "pg" ? { dialect: "pg" as const } : {}),
                            status: "error",
                            targetEnv: tgtEnv,
                            database: tgt.database,
                            source: sourceDescription,
                            durationMs: Date.now() - start,
                            error: String(err),
                        },
                        opts.format,
                    );
                    process.exit(1);
                }

                reportRestore(
                    {
                        ...(tgt.dialect === "pg" ? { dialect: "pg" as const } : {}),
                        status: "success",
                        targetEnv: tgtEnv,
                        database: tgt.database,
                        source: sourceDescription,
                        ...(sizeMb !== undefined ? { sizeMb: Number.parseFloat(sizeMb) } : {}),
                        durationMs: Date.now() - start,
                    },
                    opts.format,
                );
            },
        );

    dbCmd
        .command("restore-folder")
        .description("Restore a database from a local or mounted filesystem directory")
        .argument("<target-env>", "Destination config keyword (from TOML [db.<label>])")
        .option("--dir <path>", "Destination directory containing backups [Required if not in TOML: [backup_folder].dir]")
        .option("--file-prefix <prefix>", "Override backup filename prefix filter [Optional, fallback: <database>_]")
        .option("--latest", "Automatically select the newest backup matching the prefix [Optional]")
        .option("--folder <folder>", "Folder tier to pick from when using --latest (e.g. 'daily' or 'monthly') [Optional, default: [rolling].daily]")
        .option("--file <key-or-path>", "Explicit backup filename or local file path to restore [Optional]")
        .option("--list", "List available backups in folder matching the prefix and exit [Optional flag]")
        .option("--database <name>", "Override target database name on the destination server [Optional, fallback: [db.<label>].database]")
        .option("-c, --container <name>", "Run the native restore client via docker exec in this container [Optional]")
        .option("-y, --yes", "Skip interactive safety confirmation [Optional flag, recommended for cron/n8n]")
        .addOption(new Option("--format <format>", "Output reporting format").choices(["markdown", "json", "text"]).default("markdown"))
        .addHelpText(
            "after",
            `
Examples:
  # Restore 'local' database from the newest backup in [backup_folder].dir:
  $ opsync db restore-folder local --latest

  # Skip confirmation:
  $ opsync db restore-folder local --latest -y

  # Using a container:
  $ opsync db restore-folder local --latest -c mysql8

  # Specific file:
  $ opsync db restore-folder local --file prod_2026_09_20_12_00_00.sql.gz

  # Custom file prefix:
  $ opsync db restore-folder local --latest --file-prefix snapshot

  # Monthly archive:
  $ opsync db restore-folder local --latest --folder monthly

  # List available backups:
  $ opsync db restore-folder local --list

  # Structured JSON output:
  $ opsync db restore-folder local --latest -y --format json
`,
        )
        .action(
            async (
                tgtEnv: string,
                opts: {
                    dir?: string;
                    filePrefix?: string;
                    latest?: boolean;
                    folder?: string;
                    file?: string;
                    list?: boolean;
                    database?: string;
                    container?: string;
                    yes?: boolean;
                    format: OutputFormat;
                },
            ) => {
                const ctx = getCliContext();
                const rawTargetDb = ensureDbConfig(ctx, tgtEnv);
                const tgt = opts.database ? { ...rawTargetDb, database: opts.database } : rawTargetDb;

                const baseDir = opts.dir ?? ctx.settings.backup_folder.dir;
                if (!baseDir && !opts.file) {
                    console.error("❌ Error: No folder directory specified.");
                    console.error(
                        `Please provide --dir <path> or define 'dir' in [backup_folder] in your ${ctx.configDisplayName}.`,
                    );
                    process.exit(1);
                }

                const storage = baseDir ? new LocalStorage(baseDir) : undefined;
                const rollingCfg = ctx.settings.rolling;
                const prefix = resolveRestorePrefix(opts.filePrefix, tgt.database);

                if (opts.list) {
                    if (!storage) {
                        console.error("❌ Error: --dir <path> or [backup_folder].dir is required to list backups.");
                        process.exit(1);
                    }
                    if (opts.format !== "json") {
                        console.log(`🔍 Searching backups with prefix '${prefix}' in '${baseDir}'...`);
                    }
                    const allBackups = await collectBackups(
                        storage,
                        prefix,
                        { daily: rollingCfg.daily, monthly: rollingCfg.monthly },
                        DB_EXTENSIONS,
                    );
                    printBackupList(allBackups, {
                        format: opts.format,
                        prefix,
                        emptyNoun: "backups",
                        headingNoun: "backups",
                    });
                    return;
                }

                if (!opts.file && !opts.latest) {
                    console.error("❌ Error: You must specify --latest, --file <path-or-name>, or --list.");
                    console.error("Examples:");
                    console.error(`  opsync db restore-folder ${tgtEnv} --latest`);
                    console.error(`  opsync db restore-folder ${tgtEnv} --latest -y`);
                    console.error(`  opsync db restore-folder ${tgtEnv} --list`);
                    process.exit(1);
                }

                let sourceStream: StorageReadStream;
                let sourceDescription: string;

                if (opts.file) {
                    const directFile = Bun.file(opts.file);
                    if (await directFile.exists()) {
                        sourceStream = {
                            stream: directFile.stream() as ReadableStream<Uint8Array>,
                            sizeBytes: directFile.size,
                        };
                        sourceDescription = formatLocalPathSource(opts.file);
                    } else if (storage) {
                        try {
                            sourceStream = await getStreamFromStorage(storage, opts.file);
                            sourceDescription = formatStorageKeySource(opts.file, { baseDir });
                        } catch (err) {
                            console.error(`❌ Error: Backup file '${opts.file}' not found: ${err}`);
                            process.exit(1);
                        }
                    } else {
                        console.error(`❌ Error: Backup file '${opts.file}' not found.`);
                        process.exit(1);
                    }
                } else {
                    if (!storage) {
                        console.error("❌ Error: --dir <path> or [backup_folder].dir is required for --latest.");
                        process.exit(1);
                    }
                    const latestKey = await resolveLatestBackupKey(
                        storage,
                        prefix,
                        { folder: opts.folder, dailyFolder: rollingCfg.daily },
                        DB_EXTENSIONS,
                    );
                    if (!latestKey) {
                        console.error(`❌ Error: No backups found matching prefix '${prefix}' in '${baseDir}'.`);
                        console.error("Tip: Run with --list to view all available backups.");
                        process.exit(1);
                    }
                    try {
                        sourceStream = await getStreamFromStorage(storage, latestKey);
                        sourceDescription = formatStorageKeySource(latestKey, { baseDir });
                    } catch (err) {
                        console.error(`❌ Error: Failed to retrieve backup '${latestKey}': ${err}`);
                        process.exit(1);
                    }
                }

                const sizeMb =
                    sourceStream.sizeBytes !== undefined
                        ? (sourceStream.sizeBytes / (1024 * 1024)).toFixed(2)
                        : undefined;

                confirmAction(
                    "RESTORE Database from Folder (OVERWRITES TARGET DATA)",
                    [
                        `Target Engine: ${tgt.host}:${tgt.port} (${tgt.database})`,
                        `Container:     ${opts.container ?? tgt.container ?? "none (native database client)"}`,
                        `Source Backup: ${sourceDescription}`,
                        ...(sizeMb !== undefined ? [`Size:          ${sizeMb} MB`] : []),
                    ],
                    opts.yes,
                    opts.format === "json",
                );

                if (opts.format !== "json") {
                    console.log(`⏳ Streaming restore into ${tgt.database}...`);
                }
                const start = Date.now();

                try {
                    const preparedStream = prepareRestoreSqlStream(sourceStream.stream, tgt.dialect);
                    await executeRestore({
                        targetDb: tgt,
                        sqlStream: preparedStream,
                        localDir: baseDir ?? APP_CONFIG.defaultTmpDir,
                        container: opts.container,
                    });
                } catch (err) {
                    reportRestore(
                        {
                            ...(tgt.dialect === "pg" ? { dialect: "pg" as const } : {}),
                            status: "error",
                            targetEnv: tgtEnv,
                            database: tgt.database,
                            source: sourceDescription,
                            durationMs: Date.now() - start,
                            error: String(err),
                        },
                        opts.format,
                    );
                    process.exit(1);
                }

                reportRestore(
                    {
                        ...(tgt.dialect === "pg" ? { dialect: "pg" as const } : {}),
                        status: "success",
                        targetEnv: tgtEnv,
                        database: tgt.database,
                        source: sourceDescription,
                        ...(sizeMb !== undefined ? { sizeMb: Number.parseFloat(sizeMb) } : {}),
                        durationMs: Date.now() - start,
                    },
                    opts.format,
                );
            },
        );
}
