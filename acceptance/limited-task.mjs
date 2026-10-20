// Exact public acceptance task from reviewed contract356f31d6; no arbitrary argv.
export const ACCEPTANCE_TASK = Object.freeze({
  "task_id": "8e3b1c4a-6f2d-4e89-9a7b-0c5e3d2f1a4e",
  "model": "gemini-3.8-flash-high",
  "effort": "high",
  "prompt": "You are a technical documentation assistant. Given the following description of the Squire Limited MVP, generate a concise, valid JSON summary conforming strictly to the requested schema. Do not use tools, do not access files or the network. Description: Squire Limited MVP is a restricted foreground task execution runner for Google Antigravity CLI (agy). It provides: 1) Single-shot execution of bounded public text prompts. 2) Strict byte limits (prompt <= 32KB, stdout <= 1MB, stderr <= 64KB). 3) Direct child process supervision with monotonic deadline enforcement and conditional SIGTERM/SIGKILL termination attempts. Limitations: 1) No descendant process tracking or cgroup containment. 2) No crash recovery or durable session resumption. 3) No multi-step agent tool execution. 4) Output capture depends on responsive parent event loop. 5) Unsettled child processes result in UNKNOWN status and quarantined workspace. Output MUST be a single raw JSON object with keys: 'summary' (string), 'enforced_limits' (array of strings), 'known_limitations' (array of strings), and 'containment_guarantee' (string)."
});
export const ACCEPTANCE_SCOPE = "/home/zack/Documents/Codex/2026-10-07/task-14/lore-agy-public";
export const ACCEPTANCE_OUTPUT = "/home/zack/Documents/Codex/2026-10-07/task-14/lore-agy-public/output/run-8e3b1c4a-6f2d-4e89-9a7b-0c5e3d2f1a4e/squire-limited-task-output.json";
