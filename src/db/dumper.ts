import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import type { DbConfig } from "../config";
import { assertSafePathSegment, createPrivateFile } from "../files";
import { buildDumpCommand, databaseDialect, streamDatabaseCommand, tableNames } from "./client";
import { createDefinerStripTransform } from "./definer-filter";

export { stripDefiners } from "./definer-filter";

export type DumpMode = "full" | "schema" | "data";

export interface DumpOptions {
    db: DbConfig;
    mode: DumpMode;
    /** Only dump these tables (allowlist). If empty, dump the whole database. */
    tables?: string[];
    /** Tables to exclude (denylist). */
    ignoreTables?: string[];
    /** Directory where the temp and final files are written. */
    localDir: string;
    /** Filename prefix, e.g. "mydb_" */
    prefix: string;
    /** If set, run the native dump client via `docker exec -i <container>`. Otherwise run natively. */
    container?: string;
    /** If true, compress the dump file using gzip (.sql.gz). */
    gzip?: boolean;
}

export interface DumpResult {
    /** Absolute path to the final processed .sql file. */
    finalPath: string;
    /** Filename only (no directory). */
    filename: string;
}

/** Format a Date as YYYY_MM_DD_HH_MM_SS (matching the shell script convention). */
function timestamp(d: Date = new Date()): string {
    return d
        .toISOString()
        .replace("T", "_")
        .replace(/[-:]/g, "_")
        .replace(/\.\d+Z$/, "");
}

/** Build the prefix from the provided options (mirrors the shell script convention). */
export function buildPrefix(opts: { filePrefix?: string; name?: string; tables?: string[]; database: string }): string {
    const tables = tableNames(opts.tables);
    const raw = opts.filePrefix ?? opts.name ?? (tables.length ? tables.join("_") : opts.database);
    assertSafePathSegment(raw, "Backup prefix");
    return raw.endsWith("_") ? raw : `${raw}_`;
}

export async function dumpDatabase(opts: DumpOptions): Promise<DumpResult> {
    const { db, mode, tables = [], ignoreTables = [], localDir, prefix, container, gzip = false } = opts;
    await mkdir(localDir, { recursive: true, mode: 0o700 });
    const safePrefix = buildPrefix({ filePrefix: prefix, database: db.database });
    const filename = `${safePrefix}${timestamp()}_${crypto.randomUUID().slice(0, 8)}${gzip ? ".sql.gz" : ".sql"}`;
    const finalPath = join(localDir, filename);
    const plan = buildDumpCommand(db, { mode, tables, ignoreTables, container });
    const isMysql = databaseDialect(db) === "mysql";

    await createPrivateFile(finalPath, async (temporary) => {
        await streamDatabaseCommand(plan, async (stdout) => {
            // DEFINER is a MySQL construct. PostgreSQL's native script must stay intact.
            const processed = isMysql ? stdout.pipeThrough(createDefinerStripTransform()) : stdout;
            const nodeReadable = Readable.fromWeb(processed as unknown as import("node:stream/web").ReadableStream);
            const sink = createWriteStream(temporary, { mode: 0o600 });
            if (gzip) {
                await pipeline(nodeReadable, createGzip(), sink);
            } else {
                await pipeline(nodeReadable, sink);
            }
        });
    });

    return { finalPath, filename };
}

/** Kept for callers importing the original helper; commands now select from the profile. */
export const dumpMysql = dumpDatabase;
