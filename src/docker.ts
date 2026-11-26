export interface DockerOptions {
    container: string;
    user?: string;
}

/** No TTY: exports must remain byte-for-byte streams, including in cron. */
export function dockerExecArgs(opts: DockerOptions, args: string[]): string[] {
    return ["docker", "exec", "-i", ...(opts.user ? ["--user", opts.user] : []), opts.container, ...args];
}

export async function runDocker(args: string[], input?: string): Promise<string> {
    let proc: Bun.Subprocess<"ignore" | Uint8Array, "pipe", "pipe">;
    try {
        proc = Bun.spawn(args, {
            stdin: input === undefined ? "ignore" : new TextEncoder().encode(input),
            stdout: "pipe",
            stderr: "pipe",
        });
    } catch {
        throw new Error("Cannot start Docker. Check that the Docker CLI is installed and on PATH.");
    }
    const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
    ]);
    if (code !== 0) throw new Error(`Docker command failed (${code}): ${stderr.trim()}`);
    return stdout;
}

export interface ContainerInfo {
    id: string;
    name: string;
    image: string;
    service: string;
}

export function selectN8nContainer(containers: ContainerInfo[], explicit?: string): string {
    const matches = explicit
        ? containers.filter(
              (c) => c.name === explicit || c.id === explicit || (explicit.length >= 12 && c.id.startsWith(explicit)),
          )
        : containers.filter(
              (c) =>
                  c.service === "n8n" ||
                  /(^|[/_-])n8n([:_-]|$)/i.test(c.image) ||
                  /(^|[_-])n8n([_-]|$)/i.test(c.name),
          );
    const first = matches[0];
    if (!first) {
        throw new Error(
            explicit
                ? `Specified n8n container '${explicit}' is not running or does not exist.`
                : "No running n8n container found. Use --container <name-or-id>.",
        );
    }
    if (matches.length > 1) {
        throw new Error(
            `Multiple n8n containers match: ${matches.map((c) => c.name).join(", ")}. Use --container <name-or-id>.`,
        );
    }
    return first.name;
}

export async function resolveN8nContainer(explicit?: string): Promise<string> {
    const output = await runDocker([
        "docker",
        "ps",
        "--no-trunc",
        "--format",
        '{{.ID}}\t{{.Names}}\t{{.Image}}\t{{.Label "com.docker.compose.service"}}',
    ]);
    const containers = output
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => {
            const [id = "", name = "", image = "", service = ""] = line.split("\t");
            return { id, name, image, service };
        });
    return selectN8nContainer(containers, explicit);
}

/** Isolated files avoid interleaving simultaneous exports/imports and are removed on failure. */
export function n8nExportScript(kind: "workflow" | "credentials", decrypted = false): string {
    return `set -eu
umask 077
work=$(mktemp -d /tmp/opsync-export.XXXXXX)
trap 'rm -rf "$work"' EXIT HUP INT TERM
if n8n export:${kind} --all${decrypted ? " --decrypted" : ""} --output="$work/data.json" > "$work/log" 2>&1; then
  cat "$work/log" >&2
  cat "$work/data.json"
else
  status=$?
  cat "$work/log" >&2
  if [ "$status" -eq 1 ] && grep -Fxq 'No ${kind === "workflow" ? "workflows" : "credentials"} found with specified filters' "$work/log"; then
    printf '[]'
  else
    exit "$status"
  fi
fi`;
}

export function n8nImportScript(kind: "workflow" | "credentials"): string {
    return `set -eu
umask 077
work=$(mktemp -d /tmp/opsync-import.XXXXXX)
trap 'rm -rf "$work"' EXIT HUP INT TERM
cat > "$work/data.json"
n8n import:${kind} --input="$work/data.json"`;
}
