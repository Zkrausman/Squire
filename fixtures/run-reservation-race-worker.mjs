import { readFile, writeFile } from "node:fs/promises";
import { JsonRunStateStore } from "../dist/src/personal/json-run-state.js";

const [mode, directory, ticketId, runId, stateFile, callerReady, resultFile] = process.argv.slice(2);
if (!mode || !directory || !ticketId || !runId || !resultFile || !["release", "reserve"].includes(mode)) throw new Error("reservation race worker arguments are invalid");
if (callerReady) await writeFile(callerReady, "ready\n", { encoding: "utf8", flag: "wx", mode: 0o600 });

try {
  const states = new JsonRunStateStore(directory);
  if (mode === "release") {
    await states.release(ticketId, runId);
  } else {
    if (!stateFile) throw new Error("reserve worker state file is required");
    const state = JSON.parse(await readFile(stateFile, "utf8"));
    await states.reserve(state);
  }
  await writeFile(resultFile, "fulfilled\n", "utf8");
} catch (error) {
  await writeFile(resultFile, `rejected: ${error instanceof Error ? error.message : String(error)}\n`, "utf8");
  process.exitCode = 2;
}
