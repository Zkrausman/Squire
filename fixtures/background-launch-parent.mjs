import { fileURLToPath } from "node:url";
import { NodeBackgroundLauncher } from "../dist/src/personal/background-launcher.js";

const [marker, stdoutPath, stderrPath, delayText = "400"] = process.argv.slice(2);
if (!marker || !stdoutPath || !stderrPath) throw new Error("marker and log paths are required");

await new NodeBackgroundLauncher().launch({
  executable: process.execPath,
  args: [fileURLToPath(new URL("./background-child.mjs", import.meta.url)), marker, delayText],
  stdoutPath,
  stderrPath,
});
