import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPersonalMvpConfig } from "./config.js";
import { captureOwnerPiIdentity, launchFromPi, requireOwnerModels } from "./runtime-parity.js";

/** Loaded as a trusted Pi extension in the owner-facing process, not in ticket phases. */
export default function registerSquireLaunch(pi: {
  registerCommand(name: string, options: { description: string; handler(args: string, ctx: {
    cwd: string;
    modelRegistry: { getAvailable(): readonly { provider: string; id: string }[] };
    ui: { notify(message: string, level: "info" | "error"): void };
  }): Promise<void> }): void;
}): void {
  pi.registerCommand("squire-run", {
    description: "Launch a ticket with this Pi process's verified runtime identity",
    async handler(args, ctx) {
      const words = args.trim().split(/\s+/u);
      if (words.length !== 3 || !/^[A-Z][A-Z0-9]+-[1-9][0-9]*$/u.test(words[0]!) || words[1] !== "--config" || !path.isAbsolute(words[2]!)) throw new Error("usage: /squire-run TICKET-ID --config ABSOLUTE_PATH");
      const config = await loadPersonalMvpConfig(words[2]!);
      const identity = await captureOwnerPiIdentity(process.argv[1], ctx.modelRegistry, config.modelPolicy);
      requireOwnerModels(identity, config.modelPolicy);
      const cli = fileURLToPath(new URL("./cli.js", import.meta.url));
      const code = await launchFromPi(process.execPath, [cli, "run", words[0]!, "--background", "--config", words[2]!], ctx.cwd, identity);
      if (code !== 0) throw new Error(`Squire background launch failed (exit ${code}); inspect persisted status, do not retry unchanged`);
      ctx.ui.notify("Squire launch reserved; watch the returned run ID before making a delivery decision.", "info");
    },
  });
}
