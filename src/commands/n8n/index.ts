import type { Command } from "commander";
import { registerN8nBackupCommands } from "./backup";
import { registerN8nRestoreCommands } from "./restore";

export function registerN8nCommands(program: Command): void {
    const n8nCmd = program
        .command("n8n")
        .description("n8n workflows and credentials backup and restore operations");
    registerN8nBackupCommands(n8nCmd);
    registerN8nRestoreCommands(n8nCmd);
}
