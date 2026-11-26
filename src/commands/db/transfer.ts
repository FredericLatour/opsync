import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Command } from "commander";
import { buildDumpCommand, streamDatabaseCommand, tableNames, transferDatabase } from "../../db/client";
import { executeRestore, prepareRestoreSqlStream } from "../../db/restorer";
import { createPrivateFile } from "../../files";
import { confirmAction, ensureDbConfig, getCliContext } from "../context";

export function registerDbTransferCommands(dbCmd: Command): void {
    dbCmd
        .command("dump")
        .description("Dump remote table(s) directly to a local .sql file")
        .argument("<source-env>", "Source config keyword (from TOML)")
        .argument("<tables...>", "Name(s) of the target table(s)")
        .option("-o, --output <path>", "Custom target path for the file", "./dump.sql")
        .option("-c, --container <name>", "Docker container containing the selected database native clients")
        .option("-y, --yes", "Skip interactive confirmation")
        .action(async (srcEnv: string, tables: string[], opts: { container?: string; output: string; yes?: boolean }) => {
            const ctx = getCliContext();
            const { container } = opts;
            const src = ensureDbConfig(ctx, srcEnv);

            // Support backward-compatible positional output path if passed as last argument ending in .sql or containing /
            let outPath = opts.output;
            const lastTable = tables[tables.length - 1];
            if (
                opts.output === "./dump.sql" &&
                tables.length > 1 &&
                lastTable &&
                (lastTable.endsWith(".sql") || lastTable.includes("/"))
            ) {
                outPath = tables.pop() ?? opts.output;
            }

            const tableList = tableNames(tables);
            if (tableList.length === 0) {
                console.error("❌ Error: At least one table name must be specified.");
                process.exit(1);
            }

            confirmAction(
                "Dump Table(s) to Disk",
                [
                    `Container:     ${container ?? src.container ?? "native client"}`,
                    `Source Engine: ${src.host}:${src.port} (${src.database})`,
                    `Target Table:  ${tableList.join(", ")}`,
                    `Output File:   ${outPath}`,
                ],
                opts.yes,
            );

            console.log("⏳ Pulling structure and rows...");
            const plan = buildDumpCommand(src, {
                mode: "full",
                tables: tableList,
                container,
                includeRoutines: false,
            });
            await createPrivateFile(outPath, async (temporary) => {
                await streamDatabaseCommand(plan, async (stdout) => {
                    const nodeReadable = Readable.fromWeb(
                        stdout as unknown as import("node:stream/web").ReadableStream,
                    );
                    await pipeline(nodeReadable, createWriteStream(temporary, { mode: 0o600 }));
                });
            });
            console.log(`✅ Success! Written to ${outPath}`);
        });

    dbCmd
        .command("import")
        .description("Import an asset file into a target environment container")
        .argument("<target-env>", "Destination config keyword (from TOML)")
        .argument("<file-path>", "Path to the local source .sql file")
        .option("-c, --container <name>", "Docker container containing the selected database native clients")
        .option("-y, --yes", "Skip interactive confirmation")
        .action(async (tgtEnv: string, filePath: string, opts: { container?: string; yes?: boolean }) => {
            const ctx = getCliContext();
            const { container } = opts;
            const tgt = ensureDbConfig(ctx, tgtEnv);

            if (!(await Bun.file(filePath).exists())) {
                console.error(`❌ Error: Input file context missing at path '${filePath}'`);
                process.exit(1);
            }

            confirmAction(
                "OVERWRITE Target Table from File",
                [
                    `Container:     ${container ?? tgt.container ?? "native client"}`,
                    `Target Engine: ${tgt.host}:${tgt.port} (${tgt.database})`,
                    `Source File:   ${filePath}`,
                ],
                opts.yes,
            );

            console.log("⏳ Injecting schema data layers...");
            const rawStream = Bun.file(filePath).stream() as ReadableStream<Uint8Array>;
            await executeRestore({
                targetDb: tgt,
                sqlStream: prepareRestoreSqlStream(rawStream, tgt.dialect),
                container,
            });
            console.log("✅ Success! Database table updated.");
        });

    dbCmd
        .command("dump-import")
        .description("Pipe data directly across endpoints without local storage allocation")
        .argument("<source-env>", "Source ecosystem to clone from")
        .argument("<target-env>", "Destination ecosystem to overwrite")
        .argument("<tables...>", "Name(s) of the table(s) to transfer")
        .option("-c, --container <name>", "Docker container containing the selected database native clients")
        .option("--source-container <name>", "Docker container for the source client")
        .option("--target-container <name>", "Docker container for the destination client")
        .option("-y, --yes", "Skip interactive confirmation")
        .action(
            async (
                srcEnv: string,
                tgtEnv: string,
                tables: string[],
                opts: { container?: string; sourceContainer?: string; targetContainer?: string; yes?: boolean },
            ) => {
                const ctx = getCliContext();
                const { container } = opts;
                const src = ensureDbConfig(ctx, srcEnv);
                const tgt = ensureDbConfig(ctx, tgtEnv);
                if (src.dialect !== tgt.dialect) {
                    throw new Error("dump-import requires source and target profiles with the same dialect.");
                }
                const tableList = tableNames(tables);

                if (tableList.length === 0) {
                    console.error("❌ Error: At least one table name must be specified.");
                    process.exit(1);
                }

                confirmAction(
                    "DIRECT CROSS-ENVIRONMENT COPY (DEST STRUCT DELETION)",
                    [
                        `Source client: ${opts.sourceContainer ?? container ?? src.container ?? "native client"}`,
                        `Target client: ${opts.targetContainer ?? container ?? tgt.container ?? "native client"}`,
                        `From Source: ${src.host}:${src.port} (${src.database})`,
                        `To Target:   ${tgt.host}:${tgt.port} (${tgt.database})`,
                        `Table Copy:  ${tableList.join(", ")}`,
                    ],
                    opts.yes,
                );

                console.log("⏳ Streaming chunks across target layers natively...");

                await transferDatabase(src, tgt, tableList, {
                    sourceContainer: opts.sourceContainer ?? container,
                    targetContainer: opts.targetContainer ?? container,
                });

                console.log("✅ Complete! Destination table(s) mirrored.");
            },
        );
}
