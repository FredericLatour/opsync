import type { DbConfig } from "../config";
import { createDefinerStripTransform } from "./definer-filter";

export type DatabaseDialect = "mysql" | "pg";
export type DatabaseMode = "full" | "schema" | "data";

export interface DatabaseCommand {
    argv: string[];
    env: NodeJS.ProcessEnv;
    label: string;
    password: string;
}

export function databaseDialect(db: Pick<DbConfig, "dialect">): DatabaseDialect {
    return db.dialect ?? "mysql";
}

export function tableNames(values: string[] = []): string[] {
    return values.flatMap((value) => value.split(/[,\s]+/)).filter(Boolean);
}

function tablePattern(name: string): string {
    // pg_dump takes patterns, whereas the public table flags take identifiers.
    return name
        .split(".")
        .map((part) => `"${part.replaceAll('"', '""')}"`)
        .join(".");
}

function command(db: DbConfig, tool: string, args: string[], container?: string): DatabaseCommand {
    const env = { ...process.env };
    const passwordVariable = databaseDialect(db) === "pg" ? "PGPASSWORD" : "MYSQL_PWD";
    env[passwordVariable] = db.password;
    const effectiveContainer = container ?? db.container;
    return {
        argv: effectiveContainer
            ? ["docker", "exec", "-i", "-e", passwordVariable, effectiveContainer, tool, ...args]
            : [tool, ...args],
        env,
        label: effectiveContainer ? `${tool} in container ${effectiveContainer}` : tool,
        password: db.password,
    };
}

export function buildDumpCommand(
    db: DbConfig,
    opts: {
        mode: DatabaseMode;
        tables?: string[];
        ignoreTables?: string[];
        container?: string;
        /** Preserve the original table-transfer commands' scope. */
        includeRoutines?: boolean;
    },
): DatabaseCommand {
    if (!["full", "schema", "data"].includes(opts.mode)) {
        throw new Error(`Unknown dump mode: ${opts.mode}`);
    }
    const tables = tableNames(opts.tables);
    const ignored = tableNames(opts.ignoreTables);
    if (databaseDialect(db) === "pg") {
        const args = [
            "-w",
            "--host",
            db.host,
            "--port",
            String(db.port),
            "--username",
            db.user,
            "--dbname",
            db.database,
            "--format=plain",
            "--no-owner",
            "--no-privileges",
            "--no-tablespaces",
        ];
        if (opts.mode === "schema") args.push("--schema-only");
        if (opts.mode === "data") args.push("--data-only");
        else args.push("--clean", "--if-exists");
        if (tables.length) args.push("--strict-names");
        for (const table of tables) args.push("--table", tablePattern(table));
        for (const table of ignored) args.push("--exclude-table", tablePattern(table));
        return command(db, "pg_dump", args, opts.container);
    }
    const args = [
        "--no-tablespaces",
        "--port",
        String(db.port),
        "--single-transaction",
        "--quick",
        "--hex-blob",
        "--protocol=TCP",
        "--host",
        db.host,
        "-u",
        db.user,
    ];
    if (opts.includeRoutines !== false) args.push("--routines");
    if (opts.mode === "schema") args.push("--no-data");
    if (opts.mode === "data") args.push("--no-create-info");
    args.push(...ignored.map((table) => `--ignore-table=${db.database}.${table}`));
    args.push(db.database, ...tables);
    return command(db, "mysqldump", args, opts.container);
}

export function buildRestoreCommand(db: DbConfig, container?: string): DatabaseCommand {
    return databaseDialect(db) === "pg"
        ? command(
              db,
              "psql",
              [
                  "-X",
                  "-w",
                  "--set=ON_ERROR_STOP=1",
                  "--file=-",
                  "--host",
                  db.host,
                  "--port",
                  String(db.port),
                  "--username",
                  db.user,
                  "--dbname",
                  db.database,
              ],
              container,
          )
        : command(
              db,
              "mysql",
              ["--protocol=TCP", "-h", db.host, "-P", String(db.port), "-u", db.user, db.database],
              container,
          );
}

function safeError(plan: DatabaseCommand, message: string): string {
    return plan.password ? message.replaceAll(plan.password, "[redacted]") : message;
}

function failure(plan: DatabaseCommand, code: number, stderr: string): Error {
    return new Error(
        `${plan.label} exited with code ${code}${stderr.trim() ? `:\n${safeError(plan, stderr.trim())}` : ""}`,
    );
}

export async function runDatabaseCommand(plan: DatabaseCommand, input?: Uint8Array): Promise<Uint8Array> {
    let proc: Bun.Subprocess<"ignore" | Uint8Array, "pipe", "pipe">;
    try {
        proc = Bun.spawn({ cmd: plan.argv, env: plan.env, stdin: input ?? "ignore", stdout: "pipe", stderr: "pipe" });
    } catch {
        throw new Error(
            `Cannot start ${plan.label}. Install its native client or use --container with a running container containing it.`,
        );
    }
    const [output, stderr, code] = await Promise.all([
        new Response(proc.stdout).bytes(),
        new Response(proc.stderr).text(),
        proc.exited,
    ]);
    if (code !== 0) throw failure(plan, code, stderr);
    return output;
}

/** Stream a database dump client's stdout into an async consumer without buffering the full SQL in RAM. */
export async function streamDatabaseCommand(
    plan: DatabaseCommand,
    consumeStdout: (stdout: ReadableStream<Uint8Array>) => Promise<void>,
): Promise<void> {
    let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
    try {
        proc = Bun.spawn({ cmd: plan.argv, env: plan.env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    } catch {
        throw new Error(
            `Cannot start ${plan.label}. Install its native client or use --container with a running container containing it.`,
        );
    }

    const consume = (async () => {
        try {
            await consumeStdout(proc.stdout as ReadableStream<Uint8Array>);
        } catch (err) {
            proc.kill();
            throw err;
        }
    })();

    const results = await Promise.allSettled([proc.exited, new Response(proc.stderr).text(), consume]);
    const exitCode = results[0]?.status === "fulfilled" ? results[0].value : -1;
    const stderr = results[1]?.status === "fulfilled" ? results[1].value : "";
    if (exitCode !== 0) throw failure(plan, exitCode, stderr);
    if (results[2]?.status === "rejected") throw results[2].reason;
}

/** Stream SQL bytes into a database restore client's stdin without buffering the full payload in RAM. */
export async function streamDatabaseRestore(
    plan: DatabaseCommand,
    inputStream: ReadableStream<Uint8Array>,
): Promise<void> {
    let proc: Bun.Subprocess<"pipe", "pipe", "pipe">;
    try {
        proc = Bun.spawn({ cmd: plan.argv, env: plan.env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    } catch {
        throw new Error(
            `Cannot start ${plan.label}. Install its native client or use --container with a running container containing it.`,
        );
    }

    let importerExitedEarly = false;
    const exitedPromise = proc.exited.then((code) => {
        if (code !== 0) importerExitedEarly = true;
        return code;
    });

    const pump = (async () => {
        const reader = inputStream.getReader();
        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                if (value && value.byteLength > 0) {
                    proc.stdin.write(value);
                    await proc.stdin.flush();
                }
            }
        } catch (error) {
            if (!importerExitedEarly) throw error;
        } finally {
            reader.releaseLock();
            try {
                proc.stdin.end();
            } catch {
                /* importer already exited */
            }
        }
    })();

    const results = await Promise.allSettled([
        exitedPromise,
        new Response(proc.stderr).text(),
        new Response(proc.stdout).text(),
        pump,
    ]);
    const code = results[0]?.status === "fulfilled" ? results[0].value : -1;
    const stderr = results[1]?.status === "fulfilled" ? results[1].value : "";
    if (code !== 0) throw failure(plan, code, stderr);
    if (results[3]?.status === "rejected") throw results[3].reason;
}

/** Both endpoints must use the same native SQL format; this is not a migration converter. */
export async function transferDatabase(
    source: DbConfig,
    target: DbConfig,
    tables: string[],
    containers?: string | { sourceContainer?: string; targetContainer?: string },
): Promise<void> {
    if (databaseDialect(source) !== databaseDialect(target)) {
        throw new Error("dump-import requires source and target profiles with the same dialect.");
    }
    const sourceContainer = typeof containers === "string" ? containers : containers?.sourceContainer;
    const targetContainer = typeof containers === "string" ? containers : containers?.targetContainer;
    const dump = buildDumpCommand(source, { mode: "full", tables, container: sourceContainer, includeRoutines: false });
    const restore = buildRestoreCommand(target, targetContainer);
    let producer: Bun.Subprocess<"ignore", "pipe", "pipe">;
    let consumer: Bun.Subprocess<"pipe", "pipe", "pipe"> | undefined;
    try {
        consumer = Bun.spawn({ cmd: restore.argv, env: restore.env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
        producer = Bun.spawn({ cmd: dump.argv, env: dump.env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    } catch {
        consumer?.kill();
        throw new Error("Cannot start native transfer clients. Check their installation and --container.");
    }
    const exportProcess = producer;
    const importProcess = consumer;
    let firstFailure: "export" | "import" | undefined;
    const exporter = exportProcess.exited.then((code) => {
        if (code !== 0) {
            firstFailure ??= "export";
            importProcess.kill();
        }
        return code;
    });
    const importer = importProcess.exited.then((code) => {
        if (code !== 0) {
            firstFailure ??= "import";
            exportProcess.kill();
        }
        return code;
    });
    const pump = (async () => {
        const rawStream = exportProcess.stdout as ReadableStream<Uint8Array>;
        const stream =
            databaseDialect(source) === "mysql" ? rawStream.pipeThrough(createDefinerStripTransform()) : rawStream;
        try {
            for await (const chunk of stream) {
                importProcess.stdin.write(chunk);
                await importProcess.stdin.flush();
            }
        } catch (error) {
            // A broken import pipe can arrive before the importer's exit event.
            // Preserve that process's status instead of killing it and masking the error.
            firstFailure ??= "import";
            exportProcess.kill();
            throw error;
        } finally {
            try {
                importProcess.stdin.end();
            } catch {
                /* importer already exited */
            }
        }
    })();
    const results = await Promise.allSettled([
        exporter,
        importer,
        new Response(exportProcess.stderr).text(),
        new Response(importProcess.stderr).text(),
        new Response(importProcess.stdout).text(),
        pump,
    ]);
    const exportCode = results[0]?.status === "fulfilled" ? results[0].value : -1;
    const importCode = results[1]?.status === "fulfilled" ? results[1].value : -1;
    const exportError = results[2]?.status === "fulfilled" ? String(results[2].value) : "";
    const importError = results[3]?.status === "fulfilled" ? String(results[3].value) : "";
    if (firstFailure === "import" && importCode !== 0) throw failure(restore, importCode, importError);
    if (exportCode !== 0) throw failure(dump, exportCode, exportError);
    if (importCode !== 0) throw failure(restore, importCode, importError);
    if (results[5]?.status === "rejected") throw new Error("Native database transfer stream failed.");
}
