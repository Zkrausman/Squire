import { fileURLToPath } from "node:url";
import { NodeBackgroundLauncher } from "../dist/src/personal/background-launcher.js";

const [port, token, stdoutPath, stderrPath] = process.argv.slice(2);
if (!port || !token || !stdoutPath || !stderrPath) throw new Error("coordination and log paths are required");
await new NodeBackgroundLauncher().launch({
  executable: process.execPath,
  args: [fileURLToPath(new URL("./background-child.mjs", import.meta.url)), port, token],
  stdoutPath,
  stderrPath,
});
