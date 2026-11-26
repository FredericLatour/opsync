import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { $ } from "bun";
import { buildPrefix } from "../db/dumper";
import { findLatestBackup, listRootBackups } from "../db/restorer";
import { dockerExecArgs, n8nImportScript, runDocker } from "../docker";
import { copyPrivateFile, writePrivateFile, writePrivateStream } from "../files";
import { getStreamFromStorage, type StorageAdapter } from "../storage";
import { type N8nManifest, resolveN8nContainer } from "./dumper";

export const N8N_ARCHIVE_EXTENSIONS = [".tar.gz", ".tar"];

export interface N8nRestoreOptions {
    storage?: StorageAdapter;
    /** Label describing the source storage backend (e.g. `S3 [prod]` or `folder /backups`). */
    s3Label?: string;
    sourceBaseDir?: string;
    /** Explicit local filesystem archive path (bypasses `storage`). */
    directFilePath?: string;
    container?: string;
    user?: string;
    file?: string;
    latest?: boolean;
    folder?: string;
    dailyFolder?: string;
    filePrefix?: string;
    only?: "workflows" | "credentials";
    localDir: string;
}

export interface N8nRestoreExecutionResult {
    container: string;
    source: string;
    workflowsCount?: number;
    credentialsCount?: number;
    durationMs: number;
    manifest?: N8nManifest;
}

/**
 * Extracts a .tar.gz or .tar n8n archive into the target directory.
 */
export async function unpackN8nArchive(archivePath: string, destDir: string): Promise<void> {
    await mkdir(destDir, { recursive: true, mode: 0o700 });
    // Extract only named payloads to stdout, then write our own regular files.
    // Never let tar materialize archive paths, symlinks or hard links on disk.
    const listing = await $`tar -tf ${archivePath}`.quiet().nothrow();
    if (listing.exitCode !== 0) throw new Error("Failed to unpack n8n archive: invalid tar file");
    const names = listing.stdout.toString().trim().split("\n").filter(Boolean);
    if (names.length === 0) {
        throw new Error("Invalid n8n archive: archive is empty");
    }
    const allowed = new Set(["workflows.json", "credentials.json", "manifest.json"]);
    if (names.some((name) => !allowed.has(name)) || new Set(names).size !== names.length) {
        throw new Error("Invalid n8n archive: unexpected or duplicate entries");
    }
    const types = await $`tar -tvf ${archivePath}`.quiet().nothrow();
    if (
        types.exitCode !== 0 ||
        types.stdout
            .toString()
            .trim()
            .split("\n")
            .filter(Boolean)
            .some((line) => !line.startsWith("-"))
    ) {
        throw new Error("Invalid n8n archive: only regular files are allowed");
    }
    for (const name of names) {
        const result = await $`tar -xOf ${archivePath} ${name}`.quiet().nothrow();
        if (result.exitCode !== 0) throw new Error(`Failed to read ${name} from n8n archive`);
        await writePrivateFile(join(destDir, name), result.stdout);
    }
}

/**
 * Streams workflows and/or credentials JSON files into the n8n container via stdin and executes n8n import.
 */
export async function importN8nData(opts: {
    container: string;
    user?: string;
    workflowsJsonPath?: string;
    credentialsJsonPath?: string;
}): Promise<{ workflowsCount?: number; credentialsCount?: number }> {
    // Validate both files before modifying either kind of data.
    async function readItems(path?: string): Promise<unknown[] | undefined> {
        if (!path) return undefined;
        const value: unknown = await Bun.file(path).json();
        if (!Array.isArray(value)) throw new Error(`Invalid n8n payload in ${path}: expected an array`);
        return value;
    }
    const workflows = await readItems(opts.workflowsJsonPath);
    const credentials = await readItems(opts.credentialsJsonPath);
    async function importItems(kind: "workflow" | "credentials", items?: unknown[]) {
        if (!items?.length) return;
        await runDocker(dockerExecArgs(opts, ["sh", "-c", n8nImportScript(kind)]), JSON.stringify(items));
    }
    // Workflows can reference credentials during import.
    await importItems("credentials", credentials);
    await importItems("workflow", workflows);
    return { workflowsCount: workflows?.length, credentialsCount: credentials?.length };
}

function formatKeySource(key: string, s3Label?: string, sourceBaseDir?: string): string {
    const [folderTier, ...fileRest] = key.split("/");
    const fileOnly = fileRest.length > 0 ? fileRest.join("/") : undefined;
    if (s3Label) {
        return fileOnly
            ? `S3 [\`${s3Label}\`] folder \`${folderTier}\`, file \`${fileOnly}\``
            : `S3 [\`${s3Label}\`] file \`${key}\``;
    }
    if (sourceBaseDir) {
        return fileOnly
            ? `folder \`${sourceBaseDir}/${folderTier}\`, file \`${fileOnly}\``
            : `folder \`${sourceBaseDir}\`, file \`${key}\``;
    }
    return fileOnly ? `folder \`${folderTier}\`, file \`${fileOnly}\`` : `Local file \`${key}\``;
}

/**
 * Restores an n8n backup archive from storage (S3 or local folder) or a direct local file into a running n8n container.
 */
export async function restoreN8n(opts: N8nRestoreOptions): Promise<N8nRestoreExecutionResult> {
    const start = Date.now();
    const container = await resolveN8nContainer(opts.container);
    const prefix = opts.filePrefix !== undefined ? buildPrefix({ filePrefix: opts.filePrefix, database: "n8n" }) : "n8n_";
    const dailyFolder = opts.folder ?? opts.dailyFolder ?? "daily";

    let storageKey: string | undefined;
    let sourceDesc: string;

    if (opts.directFilePath) {
        if (!(await Bun.file(opts.directFilePath).exists())) {
            throw new Error(`Backup file '${opts.directFilePath}' not found.`);
        }
        if (opts.directFilePath.includes("/")) {
            const lastSlash = opts.directFilePath.lastIndexOf("/");
            const folder = opts.directFilePath.slice(0, lastSlash);
            const file = opts.directFilePath.slice(lastSlash + 1);
            sourceDesc = `folder \`${folder}\`, file \`${file}\``;
        } else {
            sourceDesc = `Local file \`${opts.directFilePath}\``;
        }
    } else if (opts.file) {
        if (!opts.storage) throw new Error("No storage configured for key-based restore.");
        storageKey = opts.file;
        sourceDesc = formatKeySource(storageKey, opts.s3Label, opts.sourceBaseDir);
    } else if (opts.latest) {
        if (!opts.storage) throw new Error("No storage configured for --latest restore.");
        const found = await findLatestBackup(opts.storage, dailyFolder, prefix, N8N_ARCHIVE_EXTENSIONS);
        const rootEntries = opts.folder ? [] : await listRootBackups(opts.storage, prefix, N8N_ARCHIVE_EXTENSIONS);
        const root = rootEntries[0]?.key;
        const latest =
            found && root ? (root >= found.slice(dailyFolder.length + 1) ? root : found) : (found ?? root);
        if (!latest) {
            const location = opts.s3Label ? `S3 [${opts.s3Label}]` : `'${opts.sourceBaseDir ?? "storage"}'`;
            throw new Error(`No n8n backups found matching prefix '${prefix}' in ${location}.`);
        }
        storageKey = latest;
        sourceDesc = formatKeySource(storageKey, opts.s3Label, opts.sourceBaseDir);
    } else {
        throw new Error("Must specify either --latest or --file <key> to restore.");
    }

    // Staging and extraction
    await mkdir(opts.localDir, { recursive: true, mode: 0o700 });
    const stagingDir = await mkdtemp(join(opts.localDir, "restore_"));
    const archivePath = join(stagingDir, "backup_archive.tar");

    try {
        if (opts.directFilePath) {
            await copyPrivateFile(opts.directFilePath, archivePath);
        } else if (opts.storage && storageKey) {
            const { stream, sizeBytes } = await getStreamFromStorage(opts.storage, storageKey);
            if (sizeBytes === 0) {
                throw new Error(`Backup file '${storageKey}' is empty.`);
            }
            await writePrivateStream(archivePath, stream);
            if (Bun.file(archivePath).size === 0) {
                throw new Error(`Backup file '${storageKey}' is empty or could not be retrieved.`);
            }
        }

        await unpackN8nArchive(archivePath, stagingDir);

        // Read manifest if available
        let manifest: N8nManifest | undefined;
        const manifestFile = Bun.file(join(stagingDir, "manifest.json"));
        if (await manifestFile.exists()) {
            try {
                manifest = await manifestFile.json();
            } catch {
                // optional
            }
        }

        const wfPath = opts.only === "credentials" ? undefined : join(stagingDir, "workflows.json");
        const credPath = opts.only === "workflows" ? undefined : join(stagingDir, "credentials.json");

        const counts = await importN8nData({
            container,
            user: opts.user,
            workflowsJsonPath: wfPath,
            credentialsJsonPath: credPath,
        });

        return {
            container,
            source: sourceDesc,
            workflowsCount: counts.workflowsCount,
            credentialsCount: counts.credentialsCount,
            durationMs: Date.now() - start,
            manifest,
        };
    } finally {
        await rm(stagingDir, { recursive: true, force: true });
    }
}
