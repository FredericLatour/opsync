import { type Command, Option } from "commander";
import { resolveN8nContainer } from "../../n8n/dumper";
import { N8N_ARCHIVE_EXTENSIONS, restoreN8n } from "../../n8n/restorer";
import { type OutputFormat, reportN8nRestore } from "../../reporter";
import { LocalStorage, S3Storage } from "../../storage";
import { confirmAction, getCliContext, requireS3Profile } from "../context";
import {
    collectBackups,
    formatLocalPathSource,
    formatStorageKeySource,
    printBackupList,
    resolveRestorePrefix,
} from "../shared";

export function registerN8nRestoreCommands(n8nCmd: Command): void {
    n8nCmd
        .command("restore-s3")
        .description("Restore n8n workflows and credentials from S3-compatible backup storage")
        .option("--s3 <label>", "S3 config profile label [Optional, fallback: [backup_n8n].s3 or [backup_s3].s3]")
        .option("--s3-prefix <path>", "Key prefix within the S3 bucket [Optional, fallback: [backup_n8n].prefix]")
        .option("--file-prefix <prefix>", "Override backup filename prefix filter [Optional, default: 'n8n_']")
        .option("--latest", "Automatically select the newest backup matching the prefix [Optional]")
        .option("--folder <folder>", "Folder tier to pick from when using --latest (e.g. 'daily' or 'monthly') [Optional, default: [rolling].daily]")
        .option("--file <key>", "Explicit backup S3 key to restore [Optional]")
        .option("--list", "List available backups in S3 matching the prefix and exit [Optional flag]")
        .option("--user <uid-or-name>", "User inside the n8n container (defaults to its configured user)")
        .option("-c, --container <name>", "Docker container running n8n [Optional, fallback: [backup_n8n].container or auto-detected]")
        .addOption(new Option("--only <scope>", "Restore only workflows or credentials").choices(["workflows", "credentials"]))
        .option("--tmp-dir <path>", "Local temporary staging directory [Optional, fallback: [backup_n8n].tmp_dir]")
        .option("-y, --yes", "Skip interactive safety confirmation [Optional flag]")
        .addOption(new Option("--format <format>", "Output reporting format").choices(["markdown", "json", "text"]).default("markdown"))
        .addHelpText(
            "after",
            `
Examples:
  # List available n8n backups in S3:
  $ opsync n8n restore-s3 --list

  # Restore newest backup to n8n:
  $ opsync n8n restore-s3 --latest -y

  # Restore from a specific S3 key:
  $ opsync n8n restore-s3 --file daily/n8n_2026_09_22_12_00_00.tar.gz -y

  # Restore only workflows:
  $ opsync n8n restore-s3 --latest --only workflows -y
`,
        )
        .action(
            async (opts: {
                s3?: string;
                s3Prefix?: string;
                filePrefix?: string;
                latest?: boolean;
                folder?: string;
                file?: string;
                list?: boolean;
                container?: string;
                user?: string;
                only?: "workflows" | "credentials";
                tmpDir?: string;
                yes?: boolean;
                format: OutputFormat;
            }) => {
                const start = Date.now();
                const ctx = getCliContext();
                const n8nCfg = ctx.settings.backup_n8n;
                const { label: effectiveS3Label, config: s3Cfg } = requireS3Profile(
                    ctx,
                    opts.s3 ?? n8nCfg.s3 ?? ctx.settings.backup_s3.s3,
                    "'s3' in [backup_n8n] or [backup_s3]",
                );

                const s3Prefix = opts.s3Prefix ?? n8nCfg.prefix;
                const storage = new S3Storage(s3Cfg, s3Prefix);

                const rollingCfg = ctx.settings.rolling;
                const prefix = resolveRestorePrefix(opts.filePrefix, "n8n");
                const tmpDir = opts.tmpDir ?? n8nCfg.tmp_dir;

                if (opts.list) {
                    if (opts.format !== "json") {
                        console.log(`🔍 Searching n8n backups with prefix '${prefix}' in S3 [${effectiveS3Label}]...`);
                    }
                    const allBackups = await collectBackups(
                        storage,
                        prefix,
                        { daily: rollingCfg.daily, monthly: rollingCfg.monthly },
                        N8N_ARCHIVE_EXTENSIONS,
                    );
                    printBackupList(allBackups, {
                        format: opts.format,
                        prefix,
                        emptyNoun: "n8n backups",
                        headingNoun: "n8n backups",
                    });
                    return;
                }

                if (!opts.file && !opts.latest) {
                    console.error("❌ Error: You must specify --latest, --file <key>, or --list.");
                    console.error("Examples:");
                    console.error("  opsync n8n restore-s3 --latest -y");
                    console.error("  opsync n8n restore-s3 --file daily/n8n_2026_09_22_12_00_00.tar.gz -y");
                    console.error("  opsync n8n restore-s3 --list");
                    process.exit(1);
                }

                const targetContainer = opts.container ?? n8nCfg.container;
                const container = await resolveN8nContainer(targetContainer);

                const sourceDesc = opts.file
                    ? formatStorageKeySource(opts.file, { s3Label: effectiveS3Label })
                    : `S3 [\`${effectiveS3Label}\`] latest backup (${prefix}*)`;

                confirmAction(
                    "n8n restore",
                    [
                        `Container: ${container}`,
                        `Source: ${sourceDesc}`,
                        `Scope: ${opts.only ?? "workflows & credentials"}`,
                    ],
                    opts.yes,
                    opts.format === "json",
                );

                try {
                    const restoreResult = await restoreN8n({
                        storage,
                        s3Label: effectiveS3Label,
                        container,
                        user: opts.user ?? n8nCfg.user,
                        file: opts.file,
                        latest: opts.latest,
                        folder: opts.folder,
                        dailyFolder: rollingCfg.daily,
                        filePrefix: prefix,
                        only: opts.only,
                        localDir: tmpDir,
                    });

                    reportN8nRestore(
                        {
                            status: "success",
                            service: "n8n",
                            container: restoreResult.container,
                            source: restoreResult.source,
                            workflowsCount: restoreResult.workflowsCount,
                            credentialsCount: restoreResult.credentialsCount,
                            durationMs: Date.now() - start,
                        },
                        opts.format,
                    );
                } catch (err) {
                    reportN8nRestore(
                        {
                            status: "error",
                            service: "n8n",
                            container,
                            source: sourceDesc,
                            durationMs: Date.now() - start,
                            error: String(err),
                        },
                        opts.format,
                    );
                    process.exit(1);
                }
            },
        );

    n8nCmd
        .command("restore-folder")
        .description("Restore n8n workflows and credentials from a local or mounted directory")
        .option("--dir <path>", "Directory containing n8n backups [Required if not in TOML: [backup_n8n].dir]")
        .option("--file-prefix <prefix>", "Override backup filename prefix filter [Optional, default: 'n8n_']")
        .option("--latest", "Automatically select the newest backup matching the prefix [Optional]")
        .option("--folder <folder>", "Folder tier to pick from when using --latest (e.g. 'daily' or 'monthly') [Optional, default: [rolling].daily]")
        .option("--file <key-or-path>", "Explicit backup archive filename or local file path to restore [Optional]")
        .option("--list", "List available n8n backups in folder matching the prefix and exit [Optional flag]")
        .option("--user <uid-or-name>", "User inside the n8n container (defaults to its configured user)")
        .option("-c, --container <name>", "Docker container running n8n [Optional, fallback: [backup_n8n].container or auto-detected]")
        .addOption(new Option("--only <scope>", "Restore only workflows or credentials").choices(["workflows", "credentials"]))
        .option("--tmp-dir <path>", "Local temporary staging directory [Optional, fallback: [backup_n8n].tmp_dir]")
        .option("-y, --yes", "Skip interactive safety confirmation [Optional flag]")
        .addOption(new Option("--format <format>", "Output reporting format").choices(["markdown", "json", "text"]).default("markdown"))
        .addHelpText(
            "after",
            `
Examples:
  # List available n8n backups in a folder:
  $ opsync n8n restore-folder --dir ./backups/n8n --list

  # Restore newest backup to n8n:
  $ opsync n8n restore-folder --dir ./backups/n8n --latest -y

  # Restore from a direct archive path:
  $ opsync n8n restore-folder --file ./backups/n8n/n8n_2026_09_22_12_00_00.tar.gz -y

  # Restore only workflows:
  $ opsync n8n restore-folder --dir ./backups/n8n --latest --only workflows -y
`,
        )
        .action(
            async (opts: {
                dir?: string;
                filePrefix?: string;
                latest?: boolean;
                folder?: string;
                file?: string;
                list?: boolean;
                container?: string;
                user?: string;
                only?: "workflows" | "credentials";
                tmpDir?: string;
                yes?: boolean;
                format: OutputFormat;
            }) => {
                const start = Date.now();
                const ctx = getCliContext();
                const n8nCfg = ctx.settings.backup_n8n;
                const rollingCfg = ctx.settings.rolling;

                const baseDir = opts.dir ?? n8nCfg.dir;
                if (!baseDir && !opts.file) {
                    console.error("❌ Error: No folder directory specified.");
                    console.error(
                        `Please provide --dir <path> or define 'dir' in [backup_n8n] in your ${ctx.configDisplayName}.`,
                    );
                    process.exit(1);
                }

                const storage = baseDir ? new LocalStorage(baseDir) : undefined;
                const prefix = resolveRestorePrefix(opts.filePrefix, "n8n");
                const tmpDir = opts.tmpDir ?? n8nCfg.tmp_dir;

                if (opts.list) {
                    if (!storage) {
                        console.error("❌ Error: --dir <path> or [backup_n8n].dir is required to list backups.");
                        process.exit(1);
                    }
                    if (opts.format !== "json") {
                        console.log(`🔍 Searching n8n backups with prefix '${prefix}' in '${baseDir}'...`);
                    }
                    const allBackups = await collectBackups(
                        storage,
                        prefix,
                        { daily: rollingCfg.daily, monthly: rollingCfg.monthly },
                        N8N_ARCHIVE_EXTENSIONS,
                    );
                    printBackupList(allBackups, {
                        format: opts.format,
                        prefix,
                        emptyNoun: "n8n backups",
                        headingNoun: "n8n backups",
                    });
                    return;
                }

                if (!opts.file && !opts.latest) {
                    console.error("❌ Error: You must specify --latest, --file <path-or-name>, or --list.");
                    console.error("Examples:");
                    console.error("  opsync n8n restore-folder --dir ./backups/n8n --latest -y");
                    console.error("  opsync n8n restore-folder --file ./n8n_2026_09_22_12_00_00.tar.gz -y");
                    console.error("  opsync n8n restore-folder --dir ./backups/n8n --list");
                    process.exit(1);
                }

                if (opts.latest && !storage) {
                    console.error("❌ Error: --dir <path> or [backup_n8n].dir is required for --latest.");
                    process.exit(1);
                }

                const isDirectFile = Boolean(opts.file && (await Bun.file(opts.file).exists()));
                if (opts.file && !isDirectFile && !storage) {
                    console.error(`❌ Error: Backup file '${opts.file}' not found.`);
                    process.exit(1);
                }

                const targetContainer = opts.container ?? n8nCfg.container;
                const container = await resolveN8nContainer(targetContainer);

                const sourceDesc = isDirectFile && opts.file
                    ? formatLocalPathSource(opts.file)
                    : opts.file
                      ? formatStorageKeySource(opts.file, { baseDir })
                      : `folder \`${baseDir}\` latest backup (${prefix}*)`;

                confirmAction(
                    "n8n restore from folder",
                    [
                        `Container: ${container}`,
                        `Source: ${sourceDesc}`,
                        `Scope: ${opts.only ?? "workflows & credentials"}`,
                    ],
                    opts.yes,
                    opts.format === "json",
                );

                try {
                    const restoreResult = await restoreN8n({
                        storage: isDirectFile ? undefined : storage,
                        sourceBaseDir: baseDir,
                        directFilePath: isDirectFile ? opts.file : undefined,
                        container,
                        user: opts.user ?? n8nCfg.user,
                        file: isDirectFile ? undefined : opts.file,
                        latest: opts.latest,
                        folder: opts.folder,
                        dailyFolder: rollingCfg.daily,
                        filePrefix: prefix,
                        only: opts.only,
                        localDir: tmpDir,
                    });

                    reportN8nRestore(
                        {
                            status: "success",
                            service: "n8n",
                            container: restoreResult.container,
                            source: restoreResult.source,
                            workflowsCount: restoreResult.workflowsCount,
                            credentialsCount: restoreResult.credentialsCount,
                            durationMs: Date.now() - start,
                        },
                        opts.format,
                    );
                } catch (err) {
                    reportN8nRestore(
                        {
                            status: "error",
                            service: "n8n",
                            container,
                            source: sourceDesc,
                            durationMs: Date.now() - start,
                            error: String(err),
                        },
                        opts.format,
                    );
                    process.exit(1);
                }
            },
        );
}
