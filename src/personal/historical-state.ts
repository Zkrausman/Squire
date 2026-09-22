import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { sanitizeTerminalText, validateStatusSelector } from "./status.js";

/** Historical records are display data only. Never normalize them into executable v2 state. */
export async function historicalStatus(directory: string, selector: string): Promise<string | undefined> {
  validateStatusSelector(selector);
  const ticket = /^[A-Z][A-Z0-9]+-[1-9][0-9]*$/u.test(selector);
  const names = ticket ? await readdir(directory) : [`${selector}.json`];
  const matches: Record<string, unknown>[] = [];
  for (const name of names) {
    if (!/^[a-z0-9][a-z0-9-]{7,127}\.json$/u.test(name)) continue;
    const file = path.join(directory, name);
    let info;
    try { info = await lstat(file); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") continue; throw e; }
    if (!info.isFile() || info.size > 8_000_000) throw new Error("unsafe historical state file");
    const v = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    if (v["runId"] !== name.slice(0,-5)) throw new Error("historical filename identity mismatch");
    if (ticket && v["ticketId"] !== selector) continue;
    if (v["schemaVersion"] === 2) return undefined;
    if (v["schemaVersion"] !== 1 || typeof v["ticketId"] !== "string" || !["running","failed","interrupted","completed"].includes(String(v["status"]))) throw new Error("invalid historical state");
    matches.push(v);
  }
  if (matches.length > 1) throw new Error("multiple historical runs; select an exact run ID");
  const v = matches[0];
  if (!v) return undefined;
  return ["Squire historical state (read-only; not executable or promotable)", ...["runId","ticketId","status","step","head","prUrl","lastError"].map(k => `${k}: ${sanitizeTerminalText(String(v[k] ?? "unavailable"))}`), ""].join("\n");
}
