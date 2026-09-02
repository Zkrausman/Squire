import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import path from "node:path";
import type { Role, SessionRegistration } from "../control/domain.js";

export async function validateSessionRegistration(registration: SessionRegistration, sessionRoot = "/ticket/sessions"): Promise<void> {
  if (!path.posix.isAbsolute(registration.sessionFile) || !registration.sessionFile.endsWith(`_${registration.sessionId}.jsonl`)) throw new Error("session file must be absolute and identify the session");
  const roleRoot = await realpath(path.posix.join(sessionRoot, registration.role));
  const file = await realpath(registration.sessionFile);
  if (!file.startsWith(`${roleRoot}/`) || path.posix.dirname(file) !== roleRoot) throw new Error("session file is outside exact role directory");
  const handle = await open(registration.sessionFile, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try { const stat = await handle.stat(); if (!stat.isFile()) throw new Error("session JSONL is not regular"); const first = (await handle.readFile("utf8")).split("\n", 1)[0]; if (!first) throw new Error("session JSONL is empty"); const header = JSON.parse(first) as { type?: string; id?: string }; if (header.type !== "session" || header.id !== registration.sessionId) throw new Error("session header identity mismatch"); } finally { await handle.close(); }
}
export function roleSessionDirectory(role: Role, root = "/ticket/sessions"): string { return path.posix.join(root, role); }
