import type { Command } from "commander";
import { registerDbBackupCommands } from "./backup";
import { registerDbRestoreCommands } from "./restore";
import { registerDbTransferCommands } from "./transfer";

export function registerDbCommands(program: Command): void {
    const dbCmd = program
        .command("db")
        .description("Database (MySQL/PostgreSQL) backup, restore, and sync operations");
    registerDbTransferCommands(dbCmd);
    registerDbBackupCommands(dbCmd);
    registerDbRestoreCommands(dbCmd);
}
