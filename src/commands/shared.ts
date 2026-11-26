import { buildPrefix } from "../db/dumper";
import { type BackupFileEntry, findLatestBackup, listBackups, listRootBackups } from "../db/restorer";
import { assertSafePathSegment } from "../files";
import type { OutputFormat } from "../reporter";
import type { StorageAdapter } from "../storage";

export function resolveRestorePrefix(filePrefix: string | undefined, fallbackName: string): string {
    if (filePrefix === "") return "";
    return buildPrefix({ filePrefix, database: fallbackName });
}

export function formatStorageKeySource(
    key: string,
    target: { s3Label?: string; baseDir?: string },
): string {
    const [folderTier, ...fileRest] = key.split("/");
    const fileOnly = fileRest.length > 0 ? fileRest.join("/") : undefined;
    if (target.s3Label) {
        return fileOnly
            ? `S3 [\`${target.s3Label}\`] folder \`${folderTier}\`, file \`${fileOnly}\``
            : `S3 [\`${target.s3Label}\`] file \`${key}\``;
    }
    if (target.baseDir) {
        return fileOnly
            ? `folder \`${target.baseDir}/${folderTier}\`, file \`${fileOnly}\``
            : `folder \`${target.baseDir}\`, file \`${key}\``;
    }
    return fileOnly ? `folder \`${folderTier}\`, file \`${fileOnly}\`` : `Local file \`${key}\``;
}

export function formatLocalPathSource(filePath: string): string {
    if (filePath.includes("/")) {
        const lastSlash = filePath.lastIndexOf("/");
        const folder = filePath.slice(0, lastSlash);
        const file = filePath.slice(lastSlash + 1);
        return `folder \`${folder}\`, file \`${file}\``;
    }
    return `Local file \`${filePath}\``;
}

export async function collectBackups(
    storage: StorageAdapter,
    prefix: string,
    folders: { daily: string; monthly: string },
    extensions: string[],
): Promise<BackupFileEntry[]> {
    const [tiered, root] = await Promise.all([
        listBackups(storage, prefix, folders, extensions),
        listRootBackups(storage, prefix, extensions),
    ]);
    return [...root, ...tiered];
}

export function printBackupList(
    backups: BackupFileEntry[],
    opts: {
        format: OutputFormat;
        prefix: string;
        emptyNoun: string;
        headingNoun: string;
    },
): void {
    if (opts.format === "json") {
        console.log(JSON.stringify(backups, null, 2));
        return;
    }
    if (backups.length === 0) {
        console.log(`ℹ️  No ${opts.emptyNoun} found matching prefix '${opts.prefix}'.`);
        return;
    }
    if (opts.format === "text") {
        console.log(`Available ${opts.headingNoun} (${backups.length}):`);
        for (const b of backups) {
            const gzTag = b.isGzip ? " [gzip]" : "";
            console.log(`  - [${b.folder}] ${b.filename}${gzTag}`);
        }
        return;
    }
    console.log(`📦 **Available ${opts.headingNoun}** (${backups.length}):  `);
    for (const b of backups) {
        const gzTag = b.isGzip ? " [gzip]" : "";
        console.log(`  - [\`${b.folder}\`] \`${b.filename}\`${gzTag}  `);
    }
}

export async function resolveLatestBackupKey(
    storage: StorageAdapter,
    prefix: string,
    opts: { folder?: string; dailyFolder: string },
    extensions: string[],
): Promise<string | undefined> {
    if (opts.folder) {
        const safeFolder = assertSafePathSegment(opts.folder, "Folder");
        return await findLatestBackup(storage, safeFolder, prefix, extensions);
    }

    const [folderKey, rootBackups] = await Promise.all([
        findLatestBackup(storage, opts.dailyFolder, prefix, extensions),
        listRootBackups(storage, prefix, extensions),
    ]);
    const rootKey = rootBackups[0]?.key;

    if (folderKey && rootKey) {
        const folderFilename = folderKey.startsWith(`${opts.dailyFolder}/`)
            ? folderKey.slice(opts.dailyFolder.length + 1)
            : folderKey;
        return rootKey >= folderFilename ? rootKey : folderKey;
    }
    return folderKey ?? rootKey;
}
