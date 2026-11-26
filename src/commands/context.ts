import { basename } from "node:path";
import type { Command } from "commander";
import { type DbConfig, loadSettings, type S3Config, type Settings } from "../config";

export interface CliContext {
    settings: Settings;
    configDisplayName: string;
}

const state: { ctx?: CliContext } = {};

export function getCliContext(): CliContext {
    if (!state.ctx) {
        throw new Error("CLI settings have not been initialized.");
    }
    return state.ctx;
}

export async function initializeCliContext(configPath: string | undefined, actionCommand: Command): Promise<void> {
    const result = await loadSettings(configPath);
    if (result.status === "not_found") {
        throw new Error(
            `Configuration not found. Copy opsync-example.toml to opsync.toml or use --config <path>. Searched: ${result.searchedPaths.join(", ")}`,
        );
    }
    if (result.status === "parse_error") {
        // TOML parser diagnostics may contain the line holding a secret.
        throw new Error(`Cannot read or parse TOML configuration: ${result.path}`);
    }
    if (result.status === "validation_error") {
        throw new Error(
            `Invalid configuration: ${result.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`,
        );
    }
    state.ctx = {
        settings: result.data,
        configDisplayName: basename(result.path),
    };
    if (actionCommand.opts().format !== "json") {
        console.error(`Loaded settings from: ${result.path}`);
    }
}

export function ensureDbConfig(ctx: CliContext, dbConfig: string): DbConfig {
    const config = ctx.settings.db[dbConfig];
    if (!config) {
        console.error(`❌ Error: Db Configuration '${dbConfig}' is not defined in your ${ctx.configDisplayName}.`);
        console.error(`Available options: ${Object.keys(ctx.settings.db).join(", ")}`);
        process.exit(1);
    }
    return config;
}

export function ensureS3Config(ctx: CliContext, label: string): S3Config {
    const config = ctx.settings.s3?.[label];
    if (!config) {
        console.error(`❌ Error: S3 configuration '${label}' is not defined in your ${ctx.configDisplayName}.`);
        console.error(`Available options: ${Object.keys(ctx.settings.s3 ?? {}).join(", ") || "none"}`);
        process.exit(1);
    }
    return config;
}

export function requireS3Profile(
    ctx: CliContext,
    label: string | undefined,
    tomlHint: string,
): { label: string; config: S3Config } {
    if (!label) {
        console.error("❌ Error: No S3 profile specified.");
        console.error(`Please provide --s3 <profile> or define ${tomlHint} in your ${ctx.configDisplayName}.`);
        const available = Object.keys(ctx.settings.s3 ?? {});
        console.error(`Available S3 profiles: ${available.length > 0 ? available.join(", ") : "none configured"}`);
        process.exit(1);
    }
    return { label, config: ensureS3Config(ctx, label) };
}

export function confirmAction(actionName: string, details: string[], skipPrompt = false, jsonMode = false): void {
    if (jsonMode) {
        if (!skipPrompt) {
            console.error(
                "❌ Error: Interactive confirmation cannot be used with --format json. Use -y / --yes to confirm.",
            );
            process.exit(1);
        }
        return;
    }

    if (skipPrompt) {
        console.log(`ℹ️  Running action: ${actionName}`);
        for (const line of details) console.log(`  ${line}`);
        return;
    }

    if (!process.stdin.isTTY) {
        console.error("❌ Error: Interactive confirmation requires a TTY. Use -y / --yes to confirm non-interactively.");
        process.exit(1);
    }

    console.log(`⚠️  WARNING: DESTRUCTIVE OPERATION AHEAD`);
    console.log("===========================================");
    console.log(`🔹 Action: ${actionName}`);
    for (const line of details) console.log(line);
    console.log("===========================================");

    const answer = prompt("Are you sure you want to run this? (type 'yes' to confirm): ");
    if (answer?.trim().toLowerCase() !== "yes") {
        console.log("❌ Operation canceled safely.");
        process.exit(0);
    }
}
