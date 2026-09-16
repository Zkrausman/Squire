import { constants, type BigIntStats } from "node:fs";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { PERSONAL_PHASES, type PersonalPhase } from "./types.js";

export const PLAN_SUBPHASES = ["requirements", "implementation-design"] as const;
export type PlanSubphase = typeof PLAN_SUBPHASES[number];
export interface PromptSelection {
  readonly version: 1;
  readonly id: string;
  readonly root?: string;
  readonly plan: readonly PlanSubphase[];
}
export interface CapturedPrompts {
  readonly manifest: string;
  readonly phases: Readonly<Record<PersonalPhase, string>>;
  readonly subphases: Readonly<Partial<Record<PlanSubphase, string>>>;
}
export const DEFAULT_PROMPT_SELECTION: PromptSelection = deepFreeze({ version: 1, id: "default", plan: [] });
const DEFAULT_PHASES = { plan: "Analyze requirements and propose an actionable implementation design.", implement: "Implement the accepted plan and commit the intended changes.", review: "Independently review the candidate for correctness and scope.", test: "Independently validate the exact candidate commit.", retro: "Reflect on the gated work; propose lessons and follow-ups without mutation." };
const DEFAULT_SUBPHASES = { requirements: "Clarify requirements, constraints, and testable acceptance criteria.", "implementation-design": "Design the smallest cohesive implementation and its validation plan." };
export function validatePromptSelection(value: unknown): PromptSelection {
  const v = record(value, ["version", "id", "root", "plan"], "promptPolicy");
  if (v["version"] !== 1 || typeof v["id"] !== "string" || !/^[a-z][a-z0-9-]{0,63}$/u.test(v["id"])) throw new Error("invalid prompt set version or ID");
  if (v["root"] !== undefined && (typeof v["root"] !== "string" || !path.isAbsolute(v["root"]) || v["root"].includes("\0"))) throw new Error("prompt root must be absolute");
  if (v["root"] === undefined && v["id"] !== "default") throw new Error("unknown prompt set ID");
  if (!Array.isArray(v["plan"]) || v["plan"].some(id => !PLAN_SUBPHASES.includes(id)) || new Set(v["plan"]).size !== v["plan"].length) throw new Error("unknown or duplicate Plan subphase ID");
  return deepFreeze({ version: 1, id: v["id"], ...(v["root"] === undefined ? {} : { root: v["root"] as string }), plan: [...v["plan"]] });
}
export function builtinPrompts(selection = DEFAULT_PROMPT_SELECTION): CapturedPrompts {
  return deepFreeze({ manifest: encode(JSON.stringify({ version: 1, id: "default", phases: DEFAULT_PHASES, subphases: DEFAULT_SUBPHASES })), phases: Object.fromEntries(PERSONAL_PHASES.map(p => [p, encode(DEFAULT_PHASES[p])])) as Record<PersonalPhase, string>, subphases: Object.fromEntries(selection.plan.map(p => [p, encode(DEFAULT_SUBPHASES[p])])) });
}
/** Test seams are at the actual lstat -> open and descriptor read boundaries. */
export interface CaptureHooks {
  beforePin?(directory: string): Promise<void>;
  afterPin?(directory: string): Promise<void>;
  beforeFileOpen?(name: string): Promise<void>;
  afterFileOpen?(name: string): Promise<void>;
  duringRead?(name: string): Promise<void>;
}

export async function capturePromptSet(selection: PromptSelection, repository: string, hooks: CaptureHooks = {}): Promise<CapturedPrompts> {
  selection = validatePromptSelection(selection);
  if (!selection.root) return builtinPrompts(selection);
  const root = path.resolve(selection.root);
  const repo = await realpath(repository).catch(error => {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return path.resolve(repository);
  });
  if (within(repo, root) || within(repo, await realpath(root))) throw new Error("prompt sources must be outside repository");
  const directories: { name: string; handle: FileHandle; identity: BigIntStats }[] = [];
  const descriptorPath = (handle: FileHandle, name: string) => `${process.platform === "linux" ? "/proc/self/fd" : "/dev/fd"}/${handle.fd}/${name}`;
  const checkChain = async () => {
    for (const entry of directories) {
      const current = await lstat(entry.name, { bigint: true });
      if (!sameIdentity(entry.identity, current) || current.isSymbolicLink()) throw new Error("prompt directory identity changed");
    }
  };
  try {
    // Each original identity is checked against the opened descriptor, retained
    // until all reads complete. Descendants open relative to that descriptor,
    // not a fresh pathname trust anchor. No symlink component is accepted.
    const parsed = path.parse(root);
    const parts = [parsed.root, ...root.slice(parsed.root.length).split(path.sep).filter(Boolean)];
    let name = parsed.root;
    // Snapshot the entire chain before pinning anything. A later pin must
    // match this initial validation, including descendants not yet opened.
    const originals = new Map<string, BigIntStats>();
    for (let i = 0; i < parts.length; i++) {
      if (i) name = path.join(name, parts[i]!);
      const identity = await lstat(name, { bigint: true });
      if (!identity.isDirectory() || identity.isSymbolicLink()) throw new Error("unsafe prompt directory");
      originals.set(name, identity);
    }
    name = parsed.root;
    for (let i = 0; i < parts.length; i++) {
      if (i) name = path.join(name, parts[i]!);
      const parent = directories.at(-1);
      const source = parent ? descriptorPath(parent.handle, parts[i]!) : name;
      const initial = originals.get(name)!;
      if (!sameIdentity(initial, await lstat(source, { bigint: true }))) throw new Error("prompt directory identity changed before pin");
      if (!initial.isDirectory() || initial.isSymbolicLink()) throw new Error("unsafe prompt directory");
      assertOwner(initial);
      if ((Number(initial.mode) & 0o022) && (name === root || !(Number(initial.mode) & 0o1000))) throw new Error("writable prompt ancestor");
      await hooks.beforePin?.(name);
      const handle = await open(source, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      directories.push({ name, handle, identity: initial });
      await hooks.afterPin?.(name);
      if (!sameIdentity(initial, await handle.stat({ bigint: true }))) throw new Error("prompt directory identity changed before pin");
      await checkChain();
    }
    const pinned = directories.at(-1)!.handle;
    const read = async (file: string): Promise<string> => {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u.test(file)) throw new Error("prompt file must be a direct root member");
      await checkChain();
      const source = descriptorPath(pinned, file);
      const initial = await lstat(source, { bigint: true });
      if (!initial.isFile() || initial.isSymbolicLink() || initial.nlink !== 1n || (Number(initial.mode) & 0o022)) throw new Error("unsafe prompt file");
      assertOwner(initial);
      await hooks.beforeFileOpen?.(file);
      const handle = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        await hooks.afterFileOpen?.(file);
        const before = await handle.stat({ bigint: true });
        if (!sameSnapshot(initial, before) || before.size > 262144n) throw new Error("prompt file changed or too large");
        // Bounded descriptor read; never reopen the validated pathname.
        const bytes = Buffer.alloc(Number(before.size) + 1);
        let { bytesRead } = await handle.read(bytes, 0, Math.max(1, Math.floor(bytes.length / 2)), 0);
        await hooks.duringRead?.(file);
        while (bytesRead < bytes.length) {
          const next = await handle.read(bytes, bytesRead, bytes.length - bytesRead, bytesRead);
          if (next.bytesRead === 0) break;
          bytesRead += next.bytesRead;
        }
        if (bytesRead !== Number(before.size) || !sameSnapshot(before, await handle.stat({ bigint: true })) || !sameSnapshot(before, await lstat(source, { bigint: true }))) throw new Error("prompt file changed during capture");
        await checkChain();
        const exact = bytes.subarray(0, bytesRead);
        const text = new TextDecoder("utf-8", { fatal: true }).decode(exact);
        if (!text.trim() || text.includes("\0")) throw new Error("empty or invalid prompt text");
        return exact.toString("base64");
      } finally { await handle.close(); }
    };
    const manifest = await read("manifest.json");
    const m = record(JSON.parse(decode(manifest)), ["version", "id", "phases", "subphases"], "prompt manifest");
    if (m["version"] !== 1 || m["id"] !== selection.id) throw new Error("unknown prompt set ID or manifest version");
    const phases = record(m["phases"], PERSONAL_PHASES, "manifest phases");
    const subphases = record(m["subphases"], PLAN_SUBPHASES, "manifest subphases");
    const phaseBytes = {} as Record<PersonalPhase, string>;
    const subphaseBytes: Partial<Record<PlanSubphase, string>> = {};
    // A file shared by IDs is captured only once.
    const cache = new Map<string, string>([["manifest.json", manifest]]);
    const selected = async (name: unknown) => {
      if (typeof name !== "string") throw new Error("missing prompt file in manifest");
      if (!cache.has(name)) cache.set(name, await read(name));
      return cache.get(name)!;
    };
    for (const phase of PERSONAL_PHASES) phaseBytes[phase] = await selected(phases[phase]);
    for (const id of selection.plan) subphaseBytes[id] = await selected(subphases[id]);
    // Validate unselected manifest entries too; they may not smuggle directives.
    for (const value of Object.values(subphases)) if (typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u.test(value)) throw new Error("invalid subphase file");
    return deepFreeze({ manifest, phases: phaseBytes, subphases: subphaseBytes });
  } finally { await Promise.all(directories.map(entry => entry.handle.close())); }
}
function assertOwner(s: BigIntStats): void {
  if (process.getuid && s.uid !== 0n && s.uid !== BigInt(process.getuid())) throw new Error("prompt source is not host-owned");
}
function sameIdentity(a: BigIntStats, b: BigIntStats): boolean { return a.dev === b.dev && a.ino === b.ino; }
function sameSnapshot(a: BigIntStats, b: BigIntStats): boolean { return sameIdentity(a, b) && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs && a.mode === b.mode && a.nlink === b.nlink; }
function within(parent: string, child: string): boolean { const r = path.relative(parent, child); return r === "" || (!r.startsWith(`..${path.sep}`) && r !== ".." && !path.isAbsolute(r)); }
export function record(value: unknown, allowed: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const result = value as Record<string, unknown>;
  if (Object.keys(result).some(key => !allowed.includes(key))) throw new Error(`${label} contains unknown keys`);
  return result;
}
export function deepFreeze<T>(value: T): T { if (value && typeof value === "object") { for (const child of Object.values(value)) deepFreeze(child); Object.freeze(value); } return value; }
export function encode(text: string): string { return Buffer.from(text, "utf8").toString("base64"); }
export function decode(bytes: string): string { return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(bytes, "base64")); }
