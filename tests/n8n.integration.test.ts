import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { dumpN8n } from "../src/n8n/dumper";
import { importN8nData, unpackN8nArchive } from "../src/n8n/restorer";

const container = process.env.OPSYNC_N8N_TEST_CONTAINER ?? "";
let dir: string;
describe.skipIf(!container)("n8n round trips (isolated fixture container)", () => {
    beforeAll(async () => { dir = await mkdtemp(join(tmpdir(), "opsync-n8n-")); });
    afterAll(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });
    it("backs up and restores an empty instance without fixed container names or user overrides", async () => {
        const dump = await dumpN8n({ container, localDir: dir });
        expect(dump.workflowsCount).toBe(0);
        expect(dump.credentialsCount).toBe(0);
        const extracted = join(dir, "empty");
        await unpackN8nArchive(dump.finalPath, extracted);
        expect(await importN8nData({ container, workflowsJsonPath: join(extracted, "workflows.json"), credentialsJsonPath: join(extracted, "credentials.json") })).toEqual({ workflowsCount: 0, credentialsCount: 0 });
    }, 60000);
    it("round trips workflows and decrypted credentials with the configured container user", async () => {
        const wf = join(dir, "fixture-workflows.json");
        const credentials = join(dir, "fixture-credentials.json");
        await Bun.write(wf, JSON.stringify([{ id: "opsyncFixture001", name: "Opsync fixture", nodes: [], connections: {}, settings: {}, active: false }]));
        await Bun.write(credentials, JSON.stringify([{ id: "opsyncFixture002", name: "Opsync fixture credential", type: "httpBasicAuth", data: { user: "fixture", password: "fixture-only" } }]));
        expect(await importN8nData({ container, workflowsJsonPath: wf, credentialsJsonPath: credentials })).toEqual({ workflowsCount: 1, credentialsCount: 1 });
        const dump = await dumpN8n({ container, localDir: dir, decrypted: true });
        expect(dump.workflowsCount).toBe(1);
        expect(dump.credentialsCount).toBe(1);
        const extracted = join(dir, "populated");
        await unpackN8nArchive(dump.finalPath, extracted);
        const exported = await Bun.file(join(extracted, "credentials.json")).json();
        expect(exported[0].data.password).toBe("fixture-only");
        await importN8nData({ container, workflowsJsonPath: join(extracted, "workflows.json"), credentialsJsonPath: join(extracted, "credentials.json") });
    }, 60000);
});
