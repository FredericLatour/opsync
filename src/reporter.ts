export type OutputFormat = "markdown" | "text" | "json";

export interface BackupResult {
    dialect?: "mysql" | "pg";
    status: "success" | "error";
    dbLabel: string;
    database: string;
    s3Label?: string;
    destFolder?: string;
    mode: "full" | "schema" | "data";
    gzip?: boolean;
    rolling: boolean;
    /** Absolute local path of the dump file (no-rolling) or the key in daily/ (rolling). */
    outputFile: string;
    monthlyCreated?: string;
    deletedDaily: string[];
    deletedMonthly: string[];
    durationMs: number;
    error?: string;
}

export function formatDuration(ms: number): string {
    if (ms >= 60000) {
        const totalSecs = Math.round(ms / 1000);
        const minutes = Math.floor(totalSecs / 60);
        const seconds = totalSecs % 60;
        return `${minutes}m ${seconds}s`;
    }
    if (ms >= 1000) {
        return `${(ms / 1000).toFixed(1)}s`;
    }
    return `${ms}ms`;
}

function joinMarkdownLines(lines: string[]): string {
    return lines
        .map((line) => {
            const trimmed = line.trimEnd();
            return trimmed.length > 0 ? `${trimmed}  ` : "";
        })
        .join("\n");
}

function stripMarkdown(text: string): string {
    return text
        .split("\n")
        .map((line) => line.replace(/\*\*([^*]+)\*\*/g, "$1").replace(/`([^`]+)`/g, "$1").trimEnd())
        .join("\n");
}

export function formatSource(source: string): string {
    // 1. If it already has backticks around both folder and file, ensure S3 [label] also has backticks if present
    if (source.includes("folder `") && source.includes("file `")) {
        return source.replace(/S3\s*\[([^`\]]+)\]/g, "S3 [`$1`]");
    }

    // 2. Handle S3 [label] (path) or S3 [label] `path` or S3 [label] key (path) or S3 [label] key `path`
    const s3Match = source.match(/^S3\s*\[([^\]]+)\](?:\s*key)?\s*(?:\((.*?)\)|`([^`]+)`)$/);
    if (s3Match) {
        const s3Label = s3Match[1]?.replace(/`/g, "").trim();
        const fullPath = (s3Match[2] ?? s3Match[3] ?? "").trim();
        if (fullPath.includes("/")) {
            const lastSlash = fullPath.lastIndexOf("/");
            const folder = fullPath.slice(0, lastSlash);
            const file = fullPath.slice(lastSlash + 1);
            return `S3 [\`${s3Label}\`] folder \`${folder}\`, file \`${file}\``;
        }
        return `S3 [\`${s3Label}\`] file \`${fullPath}\``;
    }

    // 3. Handle Folder / Folder path (path) or `path`
    const folderMatch = source.match(/^Folder(?:\s*path)?\s*(?:\((.*?)\)|`([^`]+)`)$/i);
    if (folderMatch) {
        const fullPath = (folderMatch[1] ?? folderMatch[2] ?? "").trim();
        if (fullPath.includes("/")) {
            const lastSlash = fullPath.lastIndexOf("/");
            const folder = fullPath.slice(0, lastSlash);
            const file = fullPath.slice(lastSlash + 1);
            return `folder \`${folder}\`, file \`${file}\``;
        }
        return `file \`${fullPath}\``;
    }

    // 4. Handle Local file (path) or `path`
    const localMatch = source.match(/^Local\s*file\s*(?:\((.*?)\)|`([^`]+)`)$/i);
    if (localMatch) {
        const file = (localMatch[1] ?? localMatch[2] ?? "").trim();
        return `Local file \`${file}\``;
    }

    // 5. If source is in backticks `...`
    const backtickMatch = source.match(/^`([^`]+)`$/);
    if (backtickMatch) {
        const fullPath = backtickMatch[1]?.trim() ?? "";
        if (fullPath.includes("/")) {
            const lastSlash = fullPath.lastIndexOf("/");
            const folder = fullPath.slice(0, lastSlash);
            const file = fullPath.slice(lastSlash + 1);
            return `folder \`${folder}\`, file \`${file}\``;
        }
        return `file \`${fullPath}\``;
    }

    // 6. Generic prefix (path)
    const genericMatch = source.match(/^(.*?)\s*\((.*?)\)$/);
    if (genericMatch) {
        let prefix = genericMatch[1]?.trim() ?? "";
        if (prefix.includes("S3 [") && !prefix.includes("S3 [`")) {
            prefix = prefix.replace(/S3\s*\[([^`\]]+)\]/g, "S3 [`$1`]");
        }
        const fullPath = genericMatch[2]?.trim() ?? "";
        if (fullPath.includes("/")) {
            const lastSlash = fullPath.lastIndexOf("/");
            const folder = fullPath.slice(0, lastSlash);
            const file = fullPath.slice(lastSlash + 1);
            return prefix
                ? `${prefix} folder \`${folder}\`, file \`${file}\``
                : `folder \`${folder}\`, file \`${file}\``;
        }
        return prefix ? `${prefix} \`${fullPath}\`` : `\`${fullPath}\``;
    }

    // 7. Plain path with slashes
    if (source.includes("/")) {
        const clean = source.replace(/`/g, "").trim();
        const lastSlash = clean.lastIndexOf("/");
        const folder = clean.slice(0, lastSlash);
        const file = clean.slice(lastSlash + 1);
        return `folder \`${folder}\`, file \`${file}\``;
    }

    // 8. Ensure S3 [label] has backticks even if no match above
    if (source.includes("S3 [") && !source.includes("S3 [`")) {
        return source.replace(/S3\s*\[([^`\]]+)\]/g, "S3 [`$1`]");
    }

    return source.includes("`") ? source : `\`${source}\``;
}

export function formatBackupReport(result: BackupResult, format: "markdown" | "text" = "markdown"): string {
    const icon = result.status === "success" ? "✅" : "❌";
    const gzipStr = result.gzip ? ", gzip" : "";
    const dest = result.s3Label
        ? `S3 [\`${result.s3Label.replace(/`/g, "")}\`]`
        : result.destFolder
          ? `folder \`${result.destFolder.replace(/`/g, "")}\``
          : "local folder";

    const outputFile = result.outputFile.includes("`") ? result.outputFile : `\`${result.outputFile}\``;

    const lines: string[] = [
        `${icon} **${result.dialect === "pg" ? "pg_dump" : "mysqldump"}** \`${result.database}\` (${result.mode} mode${gzipStr}) → ${dest}`,
        `- **Duration**: ${formatDuration(result.durationMs)}`,
        `- **Output**: ${outputFile}`,
    ];

    if (result.monthlyCreated) {
        const monthly = result.monthlyCreated.includes("`") ? result.monthlyCreated : `\`${result.monthlyCreated}\``;
        lines.push(`- **Monthly**: ${monthly} (created)`);
    }

    if (result.deletedDaily.length > 0) {
        lines.push("");
        lines.push(`🗑️  **Deleted daily files** (${result.deletedDaily.length}):`);
        for (const f of result.deletedDaily) {
            const formatted = f.includes("`") ? f : `\`${f}\``;
            lines.push(`- ${formatted}`);
        }
    }

    if (result.deletedMonthly.length > 0) {
        lines.push("");
        lines.push(`🗑️  **Deleted monthly files** (${result.deletedMonthly.length}):`);
        for (const f of result.deletedMonthly) {
            const formatted = f.includes("`") ? f : `\`${f}\``;
            lines.push(`- ${formatted}`);
        }
    }

    if (result.error) {
        lines.push(`- **Error**: ${result.error}`);
    }

    const markdown = `\n${joinMarkdownLines(lines)}`;
    return format === "text" ? stripMarkdown(markdown) : markdown;
}

export function report(result: BackupResult, format: OutputFormat): void {
    if (format === "json") {
        console.log(JSON.stringify(result, null, 2));
        return;
    }

    const text = formatBackupReport(result, format);
    if (result.status === "error") {
        console.error(text);
    } else {
        console.log(text);
    }
}

export interface RestoreResult {
    dialect?: "mysql" | "pg";
    status: "success" | "error";
    targetEnv: string;
    database: string;
    source: string;
    sizeMb?: number;
    durationMs: number;
    error?: string;
}

export function formatRestoreReport(result: RestoreResult, format: "markdown" | "text" = "markdown"): string {
    const icon = result.status === "success" ? "✅" : "❌";
    const statusText = result.status === "success" ? "" : " failed";
    const lines: string[] = [
        `${icon} **${result.dialect === "pg" ? "psql" : "mysql"}** restore \`${result.database}\`${statusText}`,
        `- **Duration**: ${formatDuration(result.durationMs)}`,
        `- **Source**: ${formatSource(result.source)}`,
    ];

    if (result.sizeMb !== undefined) {
        lines.push(`- **Size**: ${result.sizeMb} MB`);
    }

    if (result.error) {
        lines.push(`- **Error**: ${result.error}`);
    }

    const markdown = `\n${joinMarkdownLines(lines)}`;
    return format === "text" ? stripMarkdown(markdown) : markdown;
}

export function reportRestore(result: RestoreResult, format: OutputFormat): void {
    if (format === "json") {
        console.log(JSON.stringify(result, null, 2));
        return;
    }

    const text = formatRestoreReport(result, format);
    if (result.status === "error") {
        console.error(text);
    } else {
        console.log(text);
    }
}

export interface N8nBackupResult {
    status: "success" | "error";
    service: "n8n";
    container: string;
    s3Label?: string;
    destFolder?: string;
    rolling: boolean;
    gzip?: boolean;
    outputFile: string;
    workflowsCount?: number;
    credentialsCount?: number;
    decrypted?: boolean;
    monthlyCreated?: string;
    deletedDaily: string[];
    deletedMonthly: string[];
    durationMs: number;
    error?: string;
}

export function formatN8nBackupReport(result: N8nBackupResult, format: "markdown" | "text" = "markdown"): string {
    const icon = result.status === "success" ? "✅" : "❌";
    const gzipStr = result.gzip === false ? ", uncompressed" : ", gzip";
    const encStr = result.decrypted ? ", decrypted" : ", encrypted";
    const dest = result.s3Label
        ? `S3 [\`${result.s3Label.replace(/`/g, "")}\`]`
        : result.destFolder
          ? `folder \`${result.destFolder.replace(/`/g, "")}\``
          : "local folder";
    const outputFile = result.outputFile.includes("`") ? result.outputFile : `\`${result.outputFile}\``;

    const itemsPart =
        result.workflowsCount !== undefined && result.credentialsCount !== undefined
            ? ` (${result.workflowsCount} workflows, ${result.credentialsCount} credentials${encStr}${gzipStr})`
            : ` (${gzipStr.slice(2)})`;

    const lines: string[] = [
        `${icon} **n8n** backup \`${result.container}\`${itemsPart} → ${dest}`,
        `- **Duration**: ${formatDuration(result.durationMs)}`,
        `- **Output**: ${outputFile}`,
    ];

    if (result.monthlyCreated) {
        const monthly = result.monthlyCreated.includes("`") ? result.monthlyCreated : `\`${result.monthlyCreated}\``;
        lines.push(`- **Monthly**: ${monthly} (created)`);
    }

    if (result.deletedDaily.length > 0) {
        lines.push("");
        lines.push(`🗑️  **Deleted daily files** (${result.deletedDaily.length}):`);
        for (const f of result.deletedDaily) {
            const formatted = f.includes("`") ? f : `\`${f}\``;
            lines.push(`- ${formatted}`);
        }
    }

    if (result.deletedMonthly.length > 0) {
        lines.push("");
        lines.push(`🗑️  **Deleted monthly files** (${result.deletedMonthly.length}):`);
        for (const f of result.deletedMonthly) {
            const formatted = f.includes("`") ? f : `\`${f}\``;
            lines.push(`- ${formatted}`);
        }
    }

    if (result.error) {
        lines.push(`- **Error**: ${result.error}`);
    }

    const markdown = `\n${joinMarkdownLines(lines)}`;
    return format === "text" ? stripMarkdown(markdown) : markdown;
}

export function reportN8n(result: N8nBackupResult, format: OutputFormat): void {
    if (format === "json") {
        console.log(JSON.stringify(result, null, 2));
        return;
    }

    const text = formatN8nBackupReport(result, format);
    if (result.status === "error") {
        console.error(text);
    } else {
        console.log(text);
    }
}

export interface N8nRestoreResult {
    status: "success" | "error";
    service: "n8n";
    container: string;
    source: string;
    workflowsCount?: number;
    credentialsCount?: number;
    durationMs: number;
    error?: string;
}

export function formatN8nRestoreReport(result: N8nRestoreResult, format: "markdown" | "text" = "markdown"): string {
    const icon = result.status === "success" ? "✅" : "❌";
    const statusText = result.status === "success" ? "" : " failed";
    const itemsPart =
        result.workflowsCount !== undefined || result.credentialsCount !== undefined
            ? ` (${result.workflowsCount ?? 0} workflows, ${result.credentialsCount ?? 0} credentials)`
            : "";

    const lines: string[] = [
        `${icon} **n8n** restore \`${result.container}\`${itemsPart}${statusText}`,
        `- **Duration**: ${formatDuration(result.durationMs)}`,
        `- **Source**: ${formatSource(result.source)}`,
    ];

    if (result.error) {
        lines.push(`- **Error**: ${result.error}`);
    }

    const markdown = `\n${joinMarkdownLines(lines)}`;
    return format === "text" ? stripMarkdown(markdown) : markdown;
}

export function reportN8nRestore(result: N8nRestoreResult, format: OutputFormat): void {
    if (format === "json") {
        console.log(JSON.stringify(result, null, 2));
        return;
    }

    const text = formatN8nRestoreReport(result, format);
    if (result.status === "error") {
        console.error(text);
    } else {
        console.log(text);
    }
}
