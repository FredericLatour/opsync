import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { hasControlCharacters } from "./files";

export const APP_CONFIG = {
    name: "opsync",
    configFileName: "opsync.toml",
    dotConfigFileName: ".opsync.toml",
    defaultTmpDir: join(tmpdir(), "opsync"),
} as const;

export function getDefaultConfigPaths(): string[] {
    return [
        join(process.cwd(), APP_CONFIG.dotConfigFileName),
        join(process.cwd(), APP_CONFIG.configFileName),
        join(homedir(), APP_CONFIG.dotConfigFileName),
        join(homedir(), APP_CONFIG.configFileName),
    ];
}

const SafeFolderSchema = z
    .string()
    .min(1)
    .refine(
        (v) => !v.includes("/") && !v.includes("\\") && !hasControlCharacters(v) && v !== "." && v !== "..",
        "Folder name must not contain path separators or control characters",
    );

export const DbConfigSchema = z
    .object({
        dialect: z.enum(["mysql", "pg"]).default("mysql"),
        host: z.string().min(1, "Host cannot be empty"),
        port: z.coerce.number().int().min(1).max(65535, "Port must be between 1 and 65535"),
        user: z.string().min(1, "User cannot be empty"),
        password: z.string(),
        database: z.string().min(1, "Database name cannot be empty"),
        container: z.string().min(1).optional(),
    })
    .passthrough(); // tolerate extra fields from other tools (e.g. Harlequin's adapter, theme…)

export const S3ConfigSchema = z.object({
    accessKeyId: z.string().min(1, "accessKeyId cannot be empty"),
    secretAccessKey: z.string().min(1, "secretAccessKey cannot be empty"),
    sessionToken: z.string().min(1).optional(),
    endpoint: z.string().url("endpoint must be a valid URL"),
    region: z.string().min(1, "region cannot be empty"),
    bucket: z.string().min(1, "bucket cannot be empty"),
});

export const RollingConfigSchema = z.object({
    keep_last: z.number().int().positive().optional().default(15),
    keep_months: z.number().int().min(0).optional().default(12),
    daily: SafeFolderSchema.optional().default("daily"),
    monthly: SafeFolderSchema.optional().default("monthly"),
});

export const BackupFolderConfigSchema = z.object({
    dir: z.string().optional(),
    ignore_tables: z.array(z.string()).optional().default([]),
});

export const BackupS3ConfigSchema = z.object({
    s3: z.string().optional(),
    prefix: z.string().optional(),
    tmp_dir: z.string().optional().default(APP_CONFIG.defaultTmpDir),
    ignore_tables: z.array(z.string()).optional().default([]),
});

export const BackupN8nConfigSchema = z.object({
    s3: z.string().optional(),
    dir: z.string().optional(),
    prefix: z.string().optional().default("n8n"),
    tmp_dir: z.string().optional().default(APP_CONFIG.defaultTmpDir),
    container: z.string().optional(),
    user: z.string().min(1).optional(),
});

export const SettingsSchema = z.object({
    db: z
        .record(z.string(), DbConfigSchema, {
            error: (issue) => {
                if (issue.code === "invalid_type" && issue.input === undefined) {
                    return "Missing [db] configuration table";
                }
                return "[db] must be a map of database configurations";
            },
        })
        .optional()
        .default({}),
    s3: z.record(z.string(), S3ConfigSchema).optional().default({}),
    rolling: z.optional(RollingConfigSchema).transform((v) => RollingConfigSchema.parse(v ?? {})),
    backup_s3: z.optional(BackupS3ConfigSchema).transform((v) => BackupS3ConfigSchema.parse(v ?? {})),
    backup_folder: z.optional(BackupFolderConfigSchema).transform((v) => BackupFolderConfigSchema.parse(v ?? {})),
    backup_n8n: z.optional(BackupN8nConfigSchema).transform((v) => BackupN8nConfigSchema.parse(v ?? {})),
});

export type DbConfig = z.infer<typeof DbConfigSchema>;
export type S3Config = z.infer<typeof S3ConfigSchema>;
export type RollingConfig = z.infer<typeof RollingConfigSchema>;
export type BackupFolderConfig = z.infer<typeof BackupFolderConfigSchema>;
export type BackupS3Config = z.infer<typeof BackupS3ConfigSchema>;
export type BackupN8nConfig = z.infer<typeof BackupN8nConfigSchema>;
export type Settings = z.infer<typeof SettingsSchema>;

export type LoadSettingsResult =
    | { status: "success"; data: Settings; path: string }
    | { status: "not_found"; searchedPaths: string[] }
    | { status: "parse_error"; path: string; error: Error }
    | { status: "validation_error"; path: string; issues: z.ZodIssue[] };

interface MissingEnvRef {
    path: PropertyKey[];
    variable: string;
}

const ENV_REF_PATTERN = /(\$?)\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

function expandEnvRefs(
    value: unknown,
    env: Record<string, string | undefined>,
    path: PropertyKey[],
    missing: MissingEnvRef[],
): unknown {
    if (typeof value === "string") {
        return value.replace(ENV_REF_PATTERN, (_match, escaped: string, varName: string) => {
            if (escaped === "$") return `\${${varName}}`;
            const resolved = env[varName];
            if (resolved === undefined) {
                missing.push({ path, variable: varName });
                return "";
            }
            return resolved;
        });
    }
    if (Array.isArray(value)) {
        return value.map((item, idx) => expandEnvRefs(item, env, [...path, idx], missing));
    }
    if (value !== null && typeof value === "object") {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(value)) {
            out[k] = expandEnvRefs(v, env, [...path, k], missing);
        }
        return out;
    }
    return value;
}

function applyS3EnvFallbacks(parsed: unknown, env: Record<string, string | undefined>): unknown {
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return parsed;
    const root = parsed as Record<string, unknown>;
    if (!root.s3 || typeof root.s3 !== "object" || Array.isArray(root.s3)) return parsed;

    const envAccessKey = env.AWS_ACCESS_KEY_ID;
    const envSecretKey = env.AWS_SECRET_ACCESS_KEY;
    const envSessionToken = env.AWS_SESSION_TOKEN;
    const envRegion = env.AWS_REGION ?? env.AWS_DEFAULT_REGION;
    const envEndpoint = env.S3_ENDPOINT ?? env.AWS_ENDPOINT_URL_S3 ?? env.AWS_ENDPOINT_URL;

    const s3Map: Record<string, unknown> = {};
    for (const [label, entry] of Object.entries(root.s3 as Record<string, unknown>)) {
        if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
            s3Map[label] = entry;
            continue;
        }
        const profile = { ...(entry as Record<string, unknown>) };
        if (profile.accessKeyId === undefined && envAccessKey) profile.accessKeyId = envAccessKey;
        if (profile.secretAccessKey === undefined && envSecretKey) profile.secretAccessKey = envSecretKey;
        if (profile.sessionToken === undefined && envSessionToken) profile.sessionToken = envSessionToken;
        if (profile.region === undefined && envRegion) profile.region = envRegion;
        if (profile.endpoint === undefined && envEndpoint) profile.endpoint = envEndpoint;
        s3Map[label] = profile;
    }
    return { ...root, s3: s3Map };
}

export async function loadSettings(
    customFilePath?: string,
    env: Record<string, string | undefined> = process.env,
): Promise<LoadSettingsResult> {
    const searchedPaths = customFilePath ? [customFilePath] : getDefaultConfigPaths();

    for (const path of searchedPaths) {
        const file = Bun.file(path);

        if (await file.exists()) {
            let rawText: string;
            try {
                rawText = await file.text();
            } catch (err) {
                return { status: "parse_error", path, error: err as Error };
            }

            let parsedToml: unknown;
            try {
                parsedToml = Bun.TOML.parse(rawText);
            } catch (err) {
                return { status: "parse_error", path, error: err as Error };
            }

            const missingEnv: MissingEnvRef[] = [];
            const expanded = expandEnvRefs(parsedToml, env, [], missingEnv);
            if (missingEnv.length > 0) {
                const issues: z.ZodIssue[] = missingEnv.map((item) => ({
                    code: "custom",
                    path: item.path,
                    message: `Environment variable '${item.variable}' is not set`,
                }));
                return { status: "validation_error", path, issues };
            }

            const withFallbacks = applyS3EnvFallbacks(expanded, env);
            const validation = SettingsSchema.safeParse(withFallbacks);
            if (!validation.success) {
                return {
                    status: "validation_error",
                    path,
                    issues: validation.error.issues,
                };
            }

            return {
                status: "success",
                data: validation.data,
                path,
            };
        }
    }

    return { status: "not_found", searchedPaths };
}
