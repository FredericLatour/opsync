import { resolve } from "node:path";
import { randomBytes } from "node:crypto";

const project = `opsync-test-${crypto.randomUUID().slice(0, 8)}`;
const fixtureEnv = {
    ...process.env,
    GARAGE_DEFAULT_ACCESS_KEY: `GK${randomBytes(16).toString("hex")}`,
    GARAGE_DEFAULT_SECRET_KEY: randomBytes(32).toString("hex"),
};
const compose = ["docker", "compose", "-p", project, "-f", resolve(import.meta.dir, "../compose.test.yml")];
async function run(args: string[], env: NodeJS.ProcessEnv = fixtureEnv, capture = false): Promise<string> {
    const proc = Bun.spawn(args, { env, stdout: capture ? "pipe" : "inherit", stderr: "inherit" });
    const output = capture ? await new Response(proc.stdout).text() : "";
    if (await proc.exited !== 0) throw new Error(`Command failed: ${args.slice(0, 3).join(" ")}`);
    return output.trim();
}
try {
    await run([...compose, "up", "-d", "--wait", "--wait-timeout", "180"]);
    const pg = await run([...compose, "ps", "-q", "postgres"], fixtureEnv, true);
    const mysql = await run([...compose, "ps", "-q", "mysql"], fixtureEnv, true);
    const n8n = await run([...compose, "ps", "-q", "n8n"], fixtureEnv, true);
    const address = await run([...compose, "port", "garage", "3900"], fixtureEnv, true);
    const s3 = {
        accessKeyId: fixtureEnv.GARAGE_DEFAULT_ACCESS_KEY,
        secretAccessKey: fixtureEnv.GARAGE_DEFAULT_SECRET_KEY,
        endpoint: `http://${address}`, region: "garage", bucket: "opsync-fixture",
    };
    // A healthy RPC endpoint can precede default-bucket creation.
    const client = new Bun.S3Client(s3);
    for (let attempt = 0; ; attempt++) {
        try { await client.list({ maxKeys: 1 }); break; }
        catch (error) {
            if (attempt >= 29) throw error;
            await Bun.sleep(1000);
        }
    }
    await run([process.execPath, "test", "--timeout", "60000", "tests/postgres.integration.test.ts", "tests/mysql.integration.test.ts", "tests/n8n.integration.test.ts", "tests/s3.integration.test.ts"], {
        ...fixtureEnv, OPSYNC_PG_TEST_CONTAINER: pg, OPSYNC_MYSQL_TEST_CONTAINER: mysql, OPSYNC_N8N_TEST_CONTAINER: n8n,
        OPSYNC_S3_TEST_CONFIG: JSON.stringify(s3),
    });
} finally {
    await run([...compose, "down", "--volumes", "--remove-orphans"]);
}
