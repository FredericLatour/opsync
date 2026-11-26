import { describe, expect, it } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { dockerExecArgs, n8nExportScript, n8nImportScript, selectN8nContainer } from "../src/docker";

const a = { id: "a".repeat(64), name: "project-automation-1", image: "docker.n8n.io/n8nio/n8n:2", service: "automation" };
const b = { id: "b".repeat(64), name: "other-n8n-1", image: "custom:latest", service: "n8n" };

describe("Docker compatibility", () => {
    it("discovers Compose containers by image or label without a fixed container_name", () => {
        expect(selectN8nContainer([a])).toBe(a.name);
        expect(selectN8nContainer([b])).toBe(b.name);
        expect(selectN8nContainer([a, b], a.id.slice(0, 12))).toBe(a.name);
        expect(selectN8nContainer([a, b], b.name)).toBe(b.name);
    });
    it("refuses ambiguous containers and substring name matches", () => {
        expect(() => selectN8nContainer([a, b])).toThrow("Multiple");
        expect(() => selectN8nContainer([a], "automation")).toThrow("not running");
    });
    it("uses the configured container user by default and accepts numeric user/group overrides", () => {
        expect(dockerExecArgs({ container: "test" }, ["n8n"])).toEqual(["docker", "exec", "-i", "test", "n8n"]);
        expect(dockerExecArgs({ container: "test", user: "1234:1234" }, ["n8n"])).toContain("1234:1234");
    });
    it("separates export logs from JSON and removes temporary files even on failure", async () => {
        const dir = await mkdtemp(join(tmpdir(), "opsync-shell-test-"));
        try {
            await Bun.write(join(dir, "n8n"), `#!/bin/sh\nfor arg do case "$arg" in --output=*|--input=*) file="\${arg#*=}";; esac; done\nprintf '%s' "$file" > "$RECORD"\necho '[startup] {notice}'\nif [ "$FAIL" = 1 ]; then exit 7; fi\ncase "$1" in export:*) printf '[{"id":"fixture"}]' > "$file";; esac\n`, { mode: 0o755 });
            await chmod(join(dir, "n8n"), 0o755);
            async function run(script: string, fail = false) {
                const p = Bun.spawn(["sh", "-c", script], { env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, RECORD: join(dir, "path"), FAIL: fail ? "1" : "0" }, stdin: new TextEncoder().encode("[]"), stdout: "pipe", stderr: "pipe" });
                const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
                if (!(await Bun.file(join(dir, "path")).exists())) throw new Error(err);
                const file = await Bun.file(join(dir, "path")).text();
                expect(await Bun.file(file).exists()).toBe(false);
                return { out, code };
            }
            expect(await run(n8nExportScript("workflow"))).toEqual({ out: '[{"id":"fixture"}]', code: 0 });
            expect((await run(n8nExportScript("credentials"), true)).code).toBe(7);
            expect((await run(n8nImportScript("credentials"), true)).code).toBe(7);
        } finally { await rm(dir, { recursive: true, force: true }); }
    });
});
