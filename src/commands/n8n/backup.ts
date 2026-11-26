import { mkdir, mkdtemp, rm, unlink } from "node:fs/promises";
import { join } from "node:path";
import { type Command, Option } from "commander";
import { buildPrefix } from "../../db/dumper";
import { dumpN8n } from "../../n8n/dumper";
import { type N8nBackupResult, type OutputFormat, reportN8n } from "../../reporter";
import { applyRolling } from "../../rolling";
import { LocalStorage, putFileToStorage, S3Storage } from "../../storage";
import { getCliContext, requireS3Profile } from "../context";

export function registerN8nBackupCommands(n8nCmd: Command): void {
    n8nCmd
        .command("backup-s3")
        .description("Backup n8n workflows and credentials directly to S3-compatible storage (with optional rolling retention)")
        .option("--s3 <label>", "S3 config profile label [Optional, fallback: [backup_n8n].s3 or [backup_s3].s3]")
        .option("--s3-prefix <path>", "Key prefix within the S3 bucket (e.g. 'n8n/' or 'n8n/prod/') [Optional, fallback: [backup_n8n].prefix]")
        .option("--file-prefix <prefix>", "Override the export filename prefix [Optional, default: 'n8n_']")
        .option("--tmp-dir <path>", "Local temporary staging directory [Optional, fallback: [backup_n8n].tmp_dir]")
        .option("--user <uid-or-name>", "User inside the n8n container (defaults to its configured user)")
        .option("-c, --container <name>", "Docker container running n8n [Optional, fallback: [backup_n8n].container or auto-detected]")
        .option("--no-gzip", "Do not compress the backup archive with gzip (outputs .tar instead of .tar.gz)")
        .option("--rolling", "Enable daily/monthly rolling retention policy [Optional flag, default: false]", false)
        .option("--decrypted", "Export credentials in decrypted format [Optional flag, default: encrypted]", false)
        .addOption(new Option("--format <format>", "Output reporting format").choices(["markdown", "json", "text"]).default("markdown"))
        .addHelpText(
            "after",
            `
Examples:
  # Backup running n8n container to S3 configured in [backup_n8n].s3 (gzipped .tar.gz):
  $ opsync n8n backup-s3

  # With rolling retention (daily/monthly tiers in S3):
  $ opsync n8n backup-s3 --rolling

  # Without compression (uncompressed .tar):
  $ opsync n8n backup-s3 --no-gzip

  # Specific S3 profile and container:
  $ opsync n8n backup-s3 --s3 prod --container n8n-local

  # Export decrypted credentials for migration:
  $ opsync n8n backup-s3 --decrypted

  # Structured JSON output:
  $ opsync n8n backup-s3 --format json
`,
        )
        .action(
            async (opts: {
                s3?: string;
                s3Prefix?: string;
                filePrefix?: string;
                tmpDir?: string;
                container?: string;
                user?: string;
                gzip: boolean;
                rolling: boolean;
                decrypted: boolean;
                format: OutputFormat;
            }) => {
                const start = Date.now();
                const ctx = getCliContext();
                const n8nCfg = ctx.settings.backup_n8n;
                const rollingCfg = ctx.settings.rolling;

                const { label: effectiveS3Label, config: s3Cfg } = requireS3Profile(
                    ctx,
                    opts.s3 ?? n8nCfg.s3 ?? ctx.settings.backup_s3.s3,
                    "'s3' in [backup_n8n] or [backup_s3]",
                );

                const s3Prefix = opts.s3Prefix ?? n8nCfg.prefix;
                const tmpDir = opts.tmpDir ?? n8nCfg.tmp_dir;
                const targetContainer = opts.container ?? n8nCfg.container;
                const prefix = buildPrefix({ filePrefix: opts.filePrefix, database: "n8n" });
                const { gzip, rolling, decrypted } = opts;

                const storage = new S3Storage(s3Cfg, s3Prefix);

                let dumpResult: Awaited<ReturnType<typeof dumpN8n>>;
                try {
                    dumpResult = await dumpN8n({
                        container: targetContainer,
                        user: opts.user ?? n8nCfg.user,
                        prefix,
                        localDir: tmpDir,
                        gzip,
                        decrypted,
                    });
                } catch (err) {
                    const res: N8nBackupResult = {
                        status: "error",
                        service: "n8n",
                        container: targetContainer ?? "auto",
                        s3Label: effectiveS3Label,
                        rolling,
                        gzip,
                        outputFile: tmpDir,
                        decrypted,
                        deletedDaily: [],
                        deletedMonthly: [],
                        durationMs: Date.now() - start,
                        error: String(err),
                    };
                    reportN8n(res, opts.format);
                    process.exit(1);
                }

                try {
                    if (!rolling) {
                        await putFileToStorage(storage, dumpResult.filename, dumpResult.finalPath);

                        reportN8n(
                            {
                                status: "success",
                                service: "n8n",
                                container: dumpResult.container,
                                s3Label: effectiveS3Label,
                                rolling: false,
                                gzip,
                                outputFile: dumpResult.filename,
                                workflowsCount: dumpResult.workflowsCount,
                                credentialsCount: dumpResult.credentialsCount,
                                decrypted,
                                deletedDaily: [],
                                deletedMonthly: [],
                                durationMs: Date.now() - start,
                            },
                            opts.format,
                        );
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

                    reportN8n(
                        {
                            status: "success",
                            service: "n8n",
                            container: dumpResult.container,
                            s3Label: effectiveS3Label,
                            rolling: true,
                            gzip,
                            outputFile: rollingResult.dailyKey,
                            workflowsCount: dumpResult.workflowsCount,
                            credentialsCount: dumpResult.credentialsCount,
                            decrypted,
                            monthlyCreated: rollingResult.monthlyCreated,
                            deletedDaily: rollingResult.deletedDaily,
                            deletedMonthly: rollingResult.deletedMonthly,
                            durationMs: Date.now() - start,
                        },
                        opts.format,
                    );
                } catch (err) {
                    reportN8n(
                        {
                            status: "error",
                            service: "n8n",
                            container: dumpResult.container,
                            s3Label: effectiveS3Label,
                            rolling,
                            gzip,
                            outputFile: dumpResult.filename,
                            workflowsCount: dumpResult.workflowsCount,
                            credentialsCount: dumpResult.credentialsCount,
                            decrypted,
                            deletedDaily: [],
                            deletedMonthly: [],
                            durationMs: Date.now() - start,
                            error: String(err),
                        },
                        opts.format,
                    );
                    process.exitCode = 1;
                } finally {
                    await unlink(dumpResult.finalPath).catch(() => {});
                }
            },
        );

    n8nCmd
        .command("backup-folder")
        .description("Backup n8n workflows and credentials to a local or mounted directory (with optional rolling retention)")
        .option("--dir <path>", "Destination directory [Required if not in TOML: [backup_n8n].dir]")
        .option("--file-prefix <prefix>", "Override the export filename prefix [Optional, default: 'n8n_']")
        .option("--user <uid-or-name>", "User inside the n8n container (defaults to its configured user)")
        .option("-c, --container <name>", "Docker container running n8n [Optional, fallback: [backup_n8n].container or auto-detected]")
        .option("--no-gzip", "Do not compress the backup archive with gzip (outputs .tar instead of .tar.gz)")
        .option("--rolling", "Enable daily/monthly rolling retention policy [Optional flag, default: false]", false)
        .option("--decrypted", "Export credentials in decrypted format [Optional flag, default: encrypted]", false)
        .addOption(new Option("--format <format>", "Output reporting format").choices(["markdown", "json", "text"]).default("markdown"))
        .addHelpText(
            "after",
            `
Examples:
  # Backup running n8n container to [backup_n8n].dir or an explicit directory:
  $ opsync n8n backup-folder --dir ./backups/n8n

  # With rolling retention (daily/monthly tiers):
  $ opsync n8n backup-folder --dir ./backups/n8n --rolling

  # Export decrypted credentials for migration:
  $ opsync n8n backup-folder --dir ./backups/n8n --decrypted

  # Structured JSON output:
  $ opsync n8n backup-folder --dir ./backups/n8n --format json
`,
        )
        .action(
            async (opts: {
                dir?: string;
                filePrefix?: string;
                container?: string;
                user?: string;
                gzip: boolean;
                rolling: boolean;
                decrypted: boolean;
                format: OutputFormat;
            }) => {
                const start = Date.now();
                const ctx = getCliContext();
                const n8nCfg = ctx.settings.backup_n8n;
                const rollingCfg = ctx.settings.rolling;

                const destDir = opts.dir ?? n8nCfg.dir;
                if (!destDir) {
                    console.error("❌ Error: No destination folder specified.");
                    console.error(
                        `Please provide --dir <path> or define 'dir' in [backup_n8n] in your ${ctx.configDisplayName}.`,
                    );
                    process.exit(1);
                }

                const targetContainer = opts.container ?? n8nCfg.container;
                const prefix = buildPrefix({ filePrefix: opts.filePrefix, database: "n8n" });
                const { gzip, rolling, decrypted } = opts;

                if (!rolling) {
                    let dumpResult: Awaited<ReturnType<typeof dumpN8n>>;
                    try {
                        dumpResult = await dumpN8n({
                            container: targetContainer,
                            user: opts.user ?? n8nCfg.user,
                            prefix,
                            localDir: destDir,
                            gzip,
                            decrypted,
                        });
                    } catch (err) {
                        reportN8n(
                            {
                                status: "error",
                                service: "n8n",
                                container: targetContainer ?? "auto",
                                destFolder: destDir,
                                rolling: false,
                                gzip,
                                outputFile: destDir,
                                decrypted,
                                deletedDaily: [],
                                deletedMonthly: [],
                                durationMs: Date.now() - start,
                                error: String(err),
                            },
                            opts.format,
                        );
                        process.exit(1);
                    }

                    reportN8n(
                        {
                            status: "success",
                            service: "n8n",
                            container: dumpResult.container,
                            destFolder: destDir,
                            rolling: false,
                            gzip,
                            outputFile: dumpResult.finalPath,
                            workflowsCount: dumpResult.workflowsCount,
                            credentialsCount: dumpResult.credentialsCount,
                            decrypted,
                            deletedDaily: [],
                            deletedMonthly: [],
                            durationMs: Date.now() - start,
                        },
                        opts.format,
                    );
                    return;
                }

                await mkdir(destDir, { recursive: true, mode: 0o700 });
                const stagingDir = await mkdtemp(join(destDir, ".opsync-stage-"));
                try {
                    const dumpResult = await dumpN8n({
                        container: targetContainer,
                        user: opts.user ?? n8nCfg.user,
                        prefix,
                        localDir: stagingDir,
                        gzip,
                        decrypted,
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

                    reportN8n(
                        {
                            status: "success",
                            service: "n8n",
                            container: dumpResult.container,
                            destFolder: destDir,
                            rolling: true,
                            gzip,
                            outputFile: `${destDir}/${rollingResult.dailyKey}`,
                            workflowsCount: dumpResult.workflowsCount,
                            credentialsCount: dumpResult.credentialsCount,
                            decrypted,
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
                    reportN8n(
                        {
                            status: "error",
                            service: "n8n",
                            container: targetContainer ?? "auto",
                            destFolder: destDir,
                            rolling: true,
                            gzip,
                            outputFile: destDir,
                            decrypted,
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
