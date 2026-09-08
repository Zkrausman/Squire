import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

const RESOURCE_ROOT = path.join(os.tmpdir(), "squire-aidev242-actual-pi-resource-v1");
// The runtime's actual-Pi startup is a bounded shared CI resource. Two
// authenticated slots preserve genuine cross-process Pi coverage while
// preventing unrelated complete-suite workers from overcommitting startup IO.
const SLOT_COUNT = 3;
const ACQUIRE_POLL_MS = 10;
const ACQUIRE_TIMEOUT_MS = 30_000;
const RESOURCE_KIND = "squire-aidev242-actual-pi-resource";

type ResourceOwner = {
  schemaVersion: 1;
  kind: typeof RESOURCE_KIND;
  token: string;
  pid: number;
  executable: string;
  procStartTicks: string;
};

export type ActualPiResourceLease = Readonly<{
  slot: string;
  token: string;
  release: () => Promise<void>;
}>;

function isAlreadyExists(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "EEXIST");
}

function isNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT");
}

async function processIdentity(pid: number): Promise<{ executable: string; procStartTicks: string } | undefined> {
  try {
    const executable = await realpath(`/proc/${pid}/exe`);
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    const endOfCommand = stat.lastIndexOf(")");
    if (endOfCommand < 0) return undefined;
    const fields = stat.slice(endOfCommand + 1).trim().split(/\s+/u);
    const procStartTicks = fields[19];
    if (!procStartTicks) return undefined;
    return { executable, procStartTicks };
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

async function currentOwner(): Promise<ResourceOwner> {
  const identity = await processIdentity(process.pid);
  if (!identity) throw new Error("actual-Pi resource owner process identity is unavailable");
  return { schemaVersion: 1, kind: RESOURCE_KIND, token: randomUUID(), pid: process.pid, ...identity };
}

function validOwner(value: unknown): value is ResourceOwner {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return Object.keys(candidate).sort().join("\0") === ["executable", "kind", "pid", "procStartTicks", "schemaVersion", "token"].sort().join("\0")
    && candidate["schemaVersion"] === 1
    && candidate["kind"] === RESOURCE_KIND
    && typeof candidate["token"] === "string" && candidate["token"].length > 0
    && typeof candidate["pid"] === "number" && Number.isSafeInteger(candidate["pid"]) && candidate["pid"] > 0
    && typeof candidate["executable"] === "string" && path.isAbsolute(candidate["executable"])
    && typeof candidate["procStartTicks"] === "string" && /^[0-9]+$/u.test(candidate["procStartTicks"]);
}

async function staleSlot(slot: string): Promise<boolean> {
  let value: unknown;
  try { value = JSON.parse(await readFile(path.join(slot, "owner.json"), "utf8")); }
  catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
  if (!validOwner(value)) throw new Error("actual-Pi resource owner is invalid");
  const identity = await processIdentity(value.pid);
  return !identity || identity.executable !== value.executable || identity.procStartTicks !== value.procStartTicks;
}

async function releaseLease(slot: string, token: string): Promise<void> {
  let value: unknown;
  try { value = JSON.parse(await readFile(path.join(slot, "owner.json"), "utf8")); }
  catch (error) {
    if (isNotFound(error)) return;
    throw error;
  }
  if (!validOwner(value) || value.token !== token || value.pid !== process.pid) throw new Error("actual-Pi resource ownership changed before release");
  const identity = await processIdentity(process.pid);
  if (!identity || identity.executable !== value.executable || identity.procStartTicks !== value.procStartTicks) throw new Error("actual-Pi resource owner identity changed before release");
  try { await rm(slot, { recursive: true, force: false }); }
  catch (error) { if (!isNotFound(error)) throw error; }
}

export async function acquireActualPiResource(): Promise<ActualPiResourceLease> {
  await mkdir(RESOURCE_ROOT, { recursive: true, mode: 0o700 });
  const startedAt = Date.now();
  for (;;) {
    const owner = await currentOwner();
    for (let index = 0; index < SLOT_COUNT; index += 1) {
      const slot = path.join(RESOURCE_ROOT, `slot-${index}`);
      try {
        await mkdir(slot, { recursive: false, mode: 0o700 });
        try {
          await writeFile(path.join(slot, "owner.json"), `${JSON.stringify(owner)}\n`, { flag: "wx", mode: 0o600 });
        } catch (error) {
          await rm(slot, { recursive: true, force: true });
          throw error;
        }
        return Object.freeze({ slot, token: owner.token, release: () => releaseLease(slot, owner.token) });
      } catch (error) {
        if (!isAlreadyExists(error)) throw error;
        if (await staleSlot(slot)) await rm(slot, { recursive: true, force: false });
      }
    }
    if (Date.now() - startedAt >= ACQUIRE_TIMEOUT_MS) throw new Error("actual-Pi resource lease acquisition timed out");
    await new Promise(resolve => setTimeout(resolve, ACQUIRE_POLL_MS));
  }
}
