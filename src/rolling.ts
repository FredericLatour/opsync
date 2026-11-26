import { assertSafePathSegment } from "./files";
import { putFileToStorage, type StorageAdapter } from "./storage";

export interface RollingOptions {
    /** Filename prefix used to scope listing/pruning (e.g. "mydb_"). */
    prefix: string;
    keepLast: number;
    keepMonths: number;
    storage: StorageAdapter;
    /** The local path of the processed dump file to upload/move. */
    localPath: string;
    /** The filename (no directory) of the processed dump file. */
    filename: string;
    /** Subfolder or key prefix for daily backups (default: "daily"). */
    dailyFolder?: string;
    /** Subfolder or key prefix for monthly backups (default: "monthly"). */
    monthlyFolder?: string;
}

export interface RollingResult {
    /** Key/path where the file now lives in daily/. */
    dailyKey: string;
    /** Key/path of the monthly file, if newly created this run. */
    monthlyCreated?: string;
    deletedDaily: string[];
    deletedMonthly: string[];
}

export function escapeRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function dailyBackupPattern(prefix: string): RegExp {
    const escapedPrefix = escapeRegex(prefix);
    return new RegExp(`^${escapedPrefix}\\d{4}_\\d{2}_\\d{2}_\\d{2}_\\d{2}_\\d{2}(?:_[a-f0-9]+)?\\.(?:sql|tar)(?:\\.gz)?$`);
}

export function monthlyBackupPattern(prefix: string): RegExp {
    const escapedPrefix = escapeRegex(prefix);
    return new RegExp(`^${escapedPrefix}\\d{4}_\\d{2}\\.(?:sql|tar)(?:\\.gz)?$`);
}

/**
 * Matches any valid timestamped backup filename (daily or monthly) belonging to `prefix`,
 * ensuring a shorter prefix (e.g. `app_`) never matches a longer sibling (`app_staging_...`).
 */
export function backupFilenamePattern(prefix: string, extensions: string[] = [".sql", ".sql.gz"]): RegExp {
    const escapedPrefix = escapeRegex(prefix);
    const escapedExts = extensions.map(escapeRegex).join("|");
    return new RegExp(
        `^${escapedPrefix}\\d{4}_\\d{2}(?:_\\d{2}(?:_\\d{2}_\\d{2}_\\d{2})?)?(?:_[a-f0-9]+)?(?:${escapedExts})$`,
    );
}

/**
 * Apply daily/monthly rolling retention.
 *
 * Works identically on LocalStorage and S3Storage via the StorageAdapter interface.
 */
export async function applyRolling(opts: RollingOptions): Promise<RollingResult> {
    const { prefix, keepLast, keepMonths, storage, localPath, filename } = opts;
    const dailyFolder = assertSafePathSegment(opts.dailyFolder ?? "daily", "Daily folder");
    const monthlyFolder = assertSafePathSegment(opts.monthlyFolder ?? "monthly", "Monthly folder");
    if (!Number.isInteger(keepLast) || keepLast < 1 || !Number.isInteger(keepMonths) || keepMonths < 0) {
        throw new Error("Retention counts must be integers: keepLast >= 1 and keepMonths >= 0");
    }
    if (dailyFolder === monthlyFolder) throw new Error("Daily and monthly folders must be different");
    // A shorter prefix must never prune another profile's files or unrelated objects.
    const dailyPattern = dailyBackupPattern(prefix);
    const monthlyPattern = monthlyBackupPattern(prefix);
    if (!dailyPattern.test(filename)) throw new Error("Backup filename does not match its retention prefix");

    // Ensure directories (no-op on S3)
    await storage.mkdir(dailyFolder);
    await storage.mkdir(monthlyFolder);

    // ── Stream dump into daily/ ──────────────────────────────────────────────
    const dailyKey = `${dailyFolder}/${filename}`;
    await putFileToStorage(storage, dailyKey, localPath);

    // ── Prune daily: keep the last N files for this prefix ──────────────────
    const allDaily = await storage.list(`${dailyFolder}/`);
    const prefixDaily = allDaily
        .filter((k) => k.startsWith(`${dailyFolder}/`) && dailyPattern.test(k.slice(dailyFolder.length + 1)))
        .sort() // lexicographic = chronological thanks to YYYY_MM_DD_HH_MM_SS naming
        .reverse(); // newest first

    const deletedDaily: string[] = [];
    for (const key of prefixDaily.slice(keepLast)) {
        await storage.delete(key);
        deletedDaily.push(key);
    }

    // ── Monthly backup ───────────────────────────────────────────────────────
    let monthlyCreated: string | undefined;
    const deletedMonthly: string[] = [];

    if (keepMonths > 0) {
        const currentMonth = new Date()
            .toISOString()
            .slice(0, 7) // "2026-08"
            .replace("-", "_"); // "2026_08"

        const extMatch = filename.match(/(\.[a-zA-Z0-9]+(?:\.gz)?)$/);
        const ext = extMatch ? extMatch[1] : filename.endsWith(".gz") ? ".sql.gz" : ".sql";
        const monthlyKey = `${monthlyFolder}/${prefix}${currentMonth}${ext}`;

        // Only create monthly if one doesn't already exist for this month
        const existing = await storage.list(`${monthlyFolder}/${prefix}${currentMonth}`);
        if (!existing.some((k) => monthlyPattern.test(k.slice(monthlyFolder.length + 1)))) {
            await putFileToStorage(storage, monthlyKey, localPath);
            monthlyCreated = monthlyKey;
        }

        // Prune monthly: keep the last N months for this prefix
        const allMonthly = await storage.list(`${monthlyFolder}/`);
        const prefixMonthly = allMonthly
            .filter((k) => k.startsWith(`${monthlyFolder}/`) && monthlyPattern.test(k.slice(monthlyFolder.length + 1)))
            .sort()
            .reverse(); // newest first

        for (const key of prefixMonthly.slice(keepMonths)) {
            await storage.delete(key);
            deletedMonthly.push(key);
        }
    }

    return { dailyKey, monthlyCreated, deletedDaily, deletedMonthly };
}
