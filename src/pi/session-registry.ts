import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import path from "node:path";
import type { Role, SessionRegistration } from "../control/domain.js";

export async function validateSessionRegistration(registration: SessionRegistration, sessionRoot = "/ticket/sessions"): Promise<void> {
  if (!path.posix.isAbsolute(registration.sessionFile) || !registration.sessionFile.endsWith(`_${registration.sessionId}.jsonl`)) throw new Error("session file must be absolute and identify the session");
  if (constants.O_NOFOLLOW === undefined) throw new Error("secure session registration validation is unsupported on this platform");
  const roleRoot = await realpath(path.posix.join(sessionRoot, registration.role));
  const file = await realpath(registration.sessionFile);
  if (!file.startsWith(`${roleRoot}/`) || path.posix.dirname(file) !== roleRoot) throw new Error("session file is outside exact role directory");
  const handle = await open(registration.sessionFile, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size > 16 * 1024 * 1024) throw new Error("session JSONL is not a bounded unlinked regular file");
    const first = (await handle.readFile("utf8")).split("\n", 1)[0];
    const after = await handle.stat();
    if (before.dev !== after.dev || before.ino !== after.ino || before.mode !== after.mode || before.nlink !== after.nlink || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error("session JSONL changed during validation");
    if (!first) throw new Error("session JSONL is empty");
    const header = JSON.parse(first) as { type?: string; id?: string };
    if (header.type !== "session" || header.id !== registration.sessionId) throw new Error("session header identity mismatch");
  } finally { await handle.close(); }
}
export function roleSessionDirectory(role: Role, root = "/ticket/sessions"): string { return path.posix.join(root, role); }
