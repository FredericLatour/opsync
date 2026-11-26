import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { $ } from "bun";
import { buildPrefix } from "../db/dumper";
import { dockerExecArgs, n8nExportScript, resolveN8nContainer, runDocker } from "../docker";
import { createPrivateFile } from "../files";

export { resolveN8nContainer } from "../docker";

export interface N8nManifest {
    version: string;
    service: "n8n";
    container: string;
    createdAt: string;
    workflowsCount: number;
    credentialsCount: number;
    decrypted: boolean;
    gzip: boolean;
}

export interface N8nDumpOptions {
    container?: string;
    user?: string;
    prefix?: string;
    localDir: string;
    gzip?: boolean;
    decrypted?: boolean;
}

export interface N8nDumpResult {
    container: string;
    finalPath: string;
    filename: string;
    workflowsCount: number;
    credentialsCount: number;
    decrypted: boolean;
    gzip: boolean;
}

/** Format a Date as YYYY_MM_DD_HH_MM_SS (matching the shell script convention). */
export function formatTimestamp(d: Date = new Date()): string {
    return d
        .toISOString()
        .replace("T", "_")
        .replace(/[-:]/g, "_")
        .replace(/\.\d+Z$/, "");
}

/**
 * Packs workflows.json, credentials.json, and manifest.json into a .tar.gz (or .tar) archive.
 */
export async function packN8nArchive(opts: {
    stagingDir: string;
    outputFile: string;
    gzip?: boolean;
}): Promise<void> {
    const { stagingDir, outputFile, gzip = true } = opts;
    const tarFlag = gzip ? "-czf" : "-cf";
    await createPrivateFile(outputFile, async (temporary) => {
        const result = await $`tar ${tarFlag} ${temporary} -C ${stagingDir} workflows.json credentials.json manifest.json`
            .quiet()
            .nothrow();
        if (result.exitCode !== 0) throw new Error(`Failed to create n8n archive: ${result.stderr.toString().trim()}`);
    });
}

/**
 * Exports workflows and credentials from the n8n container via docker exec,
 * generates a manifest, and packages them into an atomic .tar.gz (or .tar) archive.
 */
export async function dumpN8n(opts: N8nDumpOptions): Promise<N8nDumpResult> {
    const container = await resolveN8nContainer(opts.container);
    const decrypted = opts.decrypted ?? false;
    const gzip = opts.gzip !== false;

    async function exportItems(kind: "workflow" | "credentials"): Promise<unknown[]> {
        const raw = await runDocker(
            dockerExecArgs({ container, user: opts.user }, [
                "sh",
                "-c",
                n8nExportScript(kind, kind === "credentials" && decrypted),
            ]),
        );
        try {
            const items: unknown = JSON.parse(raw);
            if (!Array.isArray(items)) throw new Error("Expected an array");
            return items;
        } catch {
            throw new Error(`Invalid JSON export for ${kind} from container '${container}'.`);
        }
    }
    const workflowsParsed = await exportItems("workflow");
    const credentialsParsed = await exportItems("credentials");

    // Staging and packaging
    const timeStr = formatTimestamp(new Date());
    const prefix = buildPrefix({ filePrefix: opts.prefix, database: "n8n" });
    const ext = gzip ? ".tar.gz" : ".tar";
    const archiveFilename = `${prefix}${timeStr}_${crypto.randomUUID().slice(0, 8)}${ext}`;

    await mkdir(opts.localDir, { recursive: true, mode: 0o700 });
    const stagingDir = await mkdtemp(join(opts.localDir, "staging_"));
    const archivePath = join(opts.localDir, archiveFilename);

    try {
        const manifest: N8nManifest = {
            version: "1.0",
            service: "n8n",
            container,
            createdAt: new Date().toISOString(),
            workflowsCount: workflowsParsed.length,
            credentialsCount: credentialsParsed.length,
            decrypted,
            gzip,
        };

        await Bun.write(join(stagingDir, "workflows.json"), JSON.stringify(workflowsParsed, null, 2));
        await Bun.write(join(stagingDir, "credentials.json"), JSON.stringify(credentialsParsed, null, 2));
        await Bun.write(join(stagingDir, "manifest.json"), JSON.stringify(manifest, null, 2));

        await packN8nArchive({ stagingDir, outputFile: archivePath, gzip });
        await chmod(archivePath, 0o600);

        return {
            container,
            finalPath: archivePath,
            filename: archiveFilename,
            workflowsCount: workflowsParsed.length,
            credentialsCount: credentialsParsed.length,
            decrypted,
            gzip,
        };
    } catch (error) {
        await rm(archivePath, { force: true });
        throw error;
    } finally {
        await rm(stagingDir, { recursive: true, force: true });
    }
}
