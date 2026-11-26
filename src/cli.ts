import { Command } from "commander";
import { version } from "../package.json";
import { initializeCliContext } from "./commands/context";
import { registerDbCommands } from "./commands/db/index";
import { registerN8nCommands } from "./commands/n8n/index";

const program = new Command();
program
    .name("opsync")
    .description("Multi-service backup, restore, and synchronization operations utility")
    .version(version)
    .option("--config <path>", "Use a specific TOML configuration file")
    .hook("preAction", async (_thisCommand, actionCommand) => {
        await initializeCliContext(program.opts().config, actionCommand);
    });

registerDbCommands(program);
registerN8nCommands(program);

try {
    await program.parseAsync();
} catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
}
