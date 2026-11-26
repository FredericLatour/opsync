import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { formatTimestamp, type N8nManifest, packN8nArchive } from "../src/n8n/dumper";
import { unpackN8nArchive } from "../src/n8n/restorer";

const TEST_DIR = join(process.cwd(), "test-n8n-packaging");

beforeEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
    await mkdir(TEST_DIR, { recursive: true });
});

afterEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
});

describe("formatTimestamp", () => {
    it("formats a Date into YYYY_MM_DD_HH_MM_SS", () => {
        const d = new Date("2026-09-22T14:30:45.123Z");
        expect(formatTimestamp(d)).toBe("2026_09_22_14_30_45");
    });
});

describe("packN8nArchive and unpackN8nArchive", () => {
    it("packs and unpacks a .tar.gz archive with workflows, credentials, and manifest", async () => {
        const stagingDir = join(TEST_DIR, "staging");
        const extractDir = join(TEST_DIR, "extracted");
        const archivePath = join(TEST_DIR, "n8n_test.tar.gz");
        await mkdir(stagingDir, { recursive: true });

        const mockWorkflows = [
            { id: "wf_1", name: "Sync CRM" },
            { id: "wf_2", name: "Alert Slack" },
        ];
        const mockCredentials = [{ id: "cred_1", name: "Slack Auth", type: "slackApi" }];
        const mockManifest: N8nManifest = {
            version: "1.0",
            service: "n8n",
            container: "n8n-local",
            createdAt: new Date().toISOString(),
            workflowsCount: 2,
            credentialsCount: 1,
            decrypted: false,
            gzip: true,
        };

        await Bun.write(join(stagingDir, "workflows.json"), JSON.stringify(mockWorkflows));
        await Bun.write(join(stagingDir, "credentials.json"), JSON.stringify(mockCredentials));
        await Bun.write(join(stagingDir, "manifest.json"), JSON.stringify(mockManifest));

        await packN8nArchive({ stagingDir, outputFile: archivePath, gzip: true });

        const archiveFile = Bun.file(archivePath);
        expect(await archiveFile.exists()).toBe(true);
        expect(archiveFile.size).toBeGreaterThan(0);

        await unpackN8nArchive(archivePath, extractDir);

        const extractedWf = await Bun.file(join(extractDir, "workflows.json")).json();
        const extractedCred = await Bun.file(join(extractDir, "credentials.json")).json();
        const extractedManifest = await Bun.file(join(extractDir, "manifest.json")).json();

        expect(extractedWf).toEqual(mockWorkflows);
        expect(extractedCred).toEqual(mockCredentials);
        expect(extractedManifest).toEqual(mockManifest);
    });

    it("packs and unpacks an uncompressed .tar archive when gzip is false", async () => {
        const stagingDir = join(TEST_DIR, "staging_tar");
        const extractDir = join(TEST_DIR, "extracted_tar");
        const archivePath = join(TEST_DIR, "n8n_test.tar");
        await mkdir(stagingDir, { recursive: true });

        await Bun.write(join(stagingDir, "workflows.json"), JSON.stringify([]));
        await Bun.write(join(stagingDir, "credentials.json"), JSON.stringify([]));
        await Bun.write(join(stagingDir, "manifest.json"), JSON.stringify({ version: "1.0" }));

        await packN8nArchive({ stagingDir, outputFile: archivePath, gzip: false });

        const archiveFile = Bun.file(archivePath);
        expect(await archiveFile.exists()).toBe(true);
        expect(archiveFile.size).toBeGreaterThan(0);

        await unpackN8nArchive(archivePath, extractDir);

        const extractedWf = await Bun.file(join(extractDir, "workflows.json")).json();
        expect(extractedWf).toEqual([]);
    });

    it("rejects empty archives before unpacking", async () => {
        const emptyArchive = join(TEST_DIR, "empty.tar");
        const p = Bun.spawn(["tar", "-cf", emptyArchive, "-T", "/dev/null"], { stdout: "pipe", stderr: "pipe" });
        expect(await p.exited).toBe(0);
        await expect(unpackN8nArchive(emptyArchive, join(TEST_DIR, "empty-out"))).rejects.toThrow("empty");
    });
});

it("rejects links and unexpected archive entries before writing payloads", async () => {
    const stagingDir = join(TEST_DIR, "unsafe");
    await mkdir(stagingDir, { recursive: true });
    await Bun.write(join(stagingDir, "outside.json"), "private fixture");
    await symlink("outside.json", join(stagingDir, "workflows.json"));
    async function archive(entry: string, name: string) {
        const path = join(TEST_DIR, name);
        const p = Bun.spawn(["tar", "-cf", path, "-C", stagingDir, entry], { stdout: "pipe", stderr: "pipe" });
        expect(await p.exited).toBe(0);
        return path;
    }
    await expect(unpackN8nArchive(await archive("workflows.json", "linked.tar"), join(TEST_DIR, "links"))).rejects.toThrow(
        "regular files",
    );
    await expect(
        unpackN8nArchive(await archive("outside.json", "unexpected.tar"), join(TEST_DIR, "unexpected")),
    ).rejects.toThrow("unexpected");
});
