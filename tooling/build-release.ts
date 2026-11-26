import { mkdir, mkdtemp, rm, copyFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { version } from "../package.json";

const target = process.argv[2];
const supported = ["bun-linux-x64", "bun-linux-arm64", "bun-darwin-x64", "bun-darwin-arm64"];
if (!target || !supported.includes(target)) throw new Error(`Choose a target: ${supported.join(", ")}`);
const tag = process.env.GITHUB_REF_TYPE === "tag" ? process.env.GITHUB_REF_NAME : undefined;
if (tag && tag !== `v${version}`) throw new Error(`Tag ${tag} does not match package.json version v${version}`);
const outDir = resolve("dist/release");
await mkdir(outDir, { recursive: true });
const work = await mkdtemp(join(outDir, ".build-"));
async function run(args: string[]) {
    const proc = Bun.spawn(args, { stdout: "inherit", stderr: "inherit" });
    if (await proc.exited !== 0) throw new Error(`Release command failed: ${args[0]}`);
}
try {
    const binary = join(work, "opsync");
    await run([process.execPath, "build", "--compile", "--minify", `--target=${target}`, "src/cli.ts", "--outfile", binary]);
    if (target === `bun-${process.platform}-${process.arch}`) {
        // Startup must work on a new machine without any local configuration.
        await run([binary, "--version"]);
        await run([binary, "--help"]);
    }
    await copyFile("LICENSE", join(work, "LICENSE"));
    await copyFile("THIRD_PARTY_NOTICES.md", join(work, "THIRD_PARTY_NOTICES.md"));
    await copyFile("README.md", join(work, "README.md"));
    await copyFile("opsync-example.toml", join(work, "opsync-example.toml"));
    const name = `opsync-${version}-${target.replace("bun-", "")}.tar.gz`;
    const archive = join(outDir, name);
    await run(["tar", "-czf", archive, "-C", work, "opsync", "LICENSE", "THIRD_PARTY_NOTICES.md", "README.md", "opsync-example.toml"]);
    const hash = new Bun.CryptoHasher("sha256").update(await Bun.file(archive).bytes()).digest("hex");
    await Bun.write(`${archive}.sha256`, `${hash}  ${name}\n`);
    console.log(`Built ${archive}`);
} finally { await rm(work, { recursive: true, force: true }); }
