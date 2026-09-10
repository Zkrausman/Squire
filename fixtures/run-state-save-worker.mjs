import { access, readFile, writeFile } from "node:fs/promises";
import { JsonRunStateStore } from "../dist/src/personal/json-run-state.js";

const [directory, stateFile, barrier, resultFile] = process.argv.slice(2);
if (!directory || !stateFile || !barrier || !resultFile) throw new Error("worker arguments are required");
while (true) {
  try {
    await access(barrier);
    break;
  } catch {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
try {
  const state = JSON.parse(await readFile(stateFile, "utf8"));
  await new JsonRunStateStore(directory).save(state);
  await writeFile(resultFile, "saved\n", "utf8");
} catch (error) {
  await writeFile(resultFile, `rejected: ${error instanceof Error ? error.message : String(error)}\n`, "utf8");
  process.exitCode = 2;
}
