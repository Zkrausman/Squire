import {
  PLAN_ALLOWED_PATH_TOOLS,
  PLAN_FILESYSTEM_POLICY_ID,
  PLAN_FILESYSTEM_POLICY_SHA256,
  PLAN_TOOL_MAX,
  PLAN_TOOL_NAME,
  type PlanPublicationContext,
  type PlanSubmission,
} from "./domain.js";
import { validatePlanSubmission, type PlanSubmissionContext } from "./plan-validation.js";

export interface PlanExtensionContext extends PlanPublicationContext {
  readonly allowedValidationCommandIds: readonly string[];
  readonly requiredValidationCommandIds: readonly string[];
}

export interface PlanExtensionPublisher {
  publish(submission: PlanSubmission, context: PlanExtensionContext): Promise<unknown>;
}

export interface PlanToolDefinition {
  readonly name: typeof PLAN_TOOL_NAME;
  readonly label: string;
  readonly description: string;
  readonly promptSnippet: string;
  readonly promptGuidelines: readonly string[];
  readonly parameters: unknown;
  execute(toolCallId: string, input: unknown): Promise<unknown>;
}

export interface PlanExtensionApi {
  registerTool(tool: PlanToolDefinition): void;
}

export function createPlanSubmissionTool(
  context: PlanExtensionContext,
  publisher: PlanExtensionPublisher,
  parameters: unknown = PLAN_TOOL_PARAMETERS,
): PlanToolDefinition {
  const validationContext: PlanSubmissionContext = {
    runId: context.runId,
    ticketIdentifier: context.ticketIdentifier,
    inputHead: context.inputHead,
    allowedValidationCommandIds: context.allowedValidationCommandIds,
    requiredValidationCommandIds: context.requiredValidationCommandIds,
  };
  let submitted = false;
  return {
    name: PLAN_TOOL_NAME,
    label: "Submit implementation plan",
    description: "Publish the one immutable, controller-bound Plan outcome and end this session.",
    promptSnippet: "Submit exactly one pass or blocked implementation plan",
    promptGuidelines: [
      "Call this tool exactly once after inspection.",
      "Use blocked when trusted context is missing, stale, contradictory, or insufficient.",
      "Never provide a destination path, run identity, session identity, or input artifact: those are controller-bound.",
    ],
    parameters,
    async execute(_toolCallId, input) {
      if (submitted) throw new Error("Plan submission tool may be called only once per session");
      submitted = true;
      const submission = validatePlanSubmission(input, validationContext);
      const publication = await publisher.publish(submission, context);
      return {
        content: [{ type: "text", text: submission.disposition === "pass" ? "Plan published; the session is complete." : "Plan blocked; implementation must not start." }],
        details: { disposition: submission.disposition, publication },
        terminate: true,
      };
    },
  };
}

export function registerPlanSubmissionTool(api: PlanExtensionApi, context: PlanExtensionContext, publisher: PlanExtensionPublisher): void {
  api.registerTool(createPlanSubmissionTool(context, publisher));
}

/**
 * The materialized source is deliberately self-contained. It imports only
 * Node primitives, so a generated extension in a run-scoped temporary agent
 * directory does not resolve code or dependencies from the workspace. The
 * controller supplies every identity and destination through trusted env.
 */
export function buildTrustedPlanExtensionSource(): string {
  return String.raw`import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, lstat, realpath, readdir } from "node:fs/promises";
import path from "node:path";

const TOOL = ${JSON.stringify(PLAN_TOOL_NAME)};
const PATH_TOOL_NAMES = ${JSON.stringify([...PLAN_ALLOWED_PATH_TOOLS])};
const MAX = ${JSON.stringify(PLAN_TOOL_MAX)};
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const FS_MAX_FILE_BYTES = 4 * 1024 * 1024;
const FS_READ_CHUNK_BYTES = 64 * 1024;
const FS_MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const FS_MAX_ENTRIES = 10_000;
const FS_MAX_FILES = 2_000;
const FS_MAX_DEPTH = 32;
const FS_POLICY_ID = ${JSON.stringify(PLAN_FILESYSTEM_POLICY_ID)};
const FS_POLICY_SHA256 = ${JSON.stringify(PLAN_FILESYSTEM_POLICY_SHA256)};
const PLAN_SCHEMA = "urn:squire:contracts:v1:implementation-plan";
const RESULT_SCHEMA = "urn:squire:contracts:v1:phase-result";
const INPUT_SCHEMA = "urn:squire:contracts:v1:phase-input";
const CONTROL = /[\u0000-\u001f\u007f]/u;
const RUN_ID = /^run_[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const HANDOFF_ID = /^handoff_[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const TICKET_ID = /^[A-Z][A-Z0-9]+-[1-9][0-9]*$/u;
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/u;
const HEAD = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const STEP_ID = /^step-[1-9][0-9]*$/u;
const COMMAND_ID = /^[a-z][a-z0-9_-]{0,63}$/u;
const UNRESOLVED = /\b(?:todo|tbd|unknown|unsure|unresolved|figure\s+out|later|not\s+known|pending)\b/iu;

function requiredEnv(name) {
  const value = process.env[name];
  if (typeof value !== "string" || value.length === 0 || CONTROL.test(value)) throw new Error("missing or unsafe trusted Plan environment: " + name);
  return value;
}
function integerEnv(name) {
  const value = Number(requiredEnv(name));
  if (!Number.isSafeInteger(value) || value < 1) throw new Error("invalid trusted Plan integer: " + name);
  return value;
}
function jsonArrayEnv(name) {
  let value;
  try { value = JSON.parse(requiredEnv(name)); } catch { throw new Error("invalid trusted Plan array: " + name); }
  if (!Array.isArray(value) || value.length > MAX.validationIds || value.some(item => typeof item !== "string" || !COMMAND_ID.test(item))) throw new Error("invalid trusted Plan array: " + name);
  if (new Set(value).size !== value.length) throw new Error("duplicate trusted Plan command id: " + name);
  return value;
}
function text(value, field, max) {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > max || CONTROL.test(value)) throw new Error(field + " is invalid or unbounded");
  return value;
}
function identifier(value, field, pattern, max) {
  const result = text(value, field, max);
  if (!pattern.test(result)) throw new Error(field + " has an invalid identity");
  return result;
}
function array(value, field, max) {
  if (!Array.isArray(value) || value.length > max) throw new Error(field + " is invalid or unbounded");
  return value;
}
function pathValue(value, field) {
  const result = text(value, field, MAX.path);
  if (result.startsWith("/") || result.startsWith("\\") || /^[A-Za-z]:/u.test(result) || result.includes("\\") || result.includes("//") || result === "." || result.split("/").some(part => part === ".." || part === "." || part.length === 0)) throw new Error(field + " is not repository-relative");
  return result;
}
function actionable(value, field, max) {
  const result = text(value, field, max);
  if (UNRESOLVED.test(result)) throw new Error(field + " is not actionable");
  return result;
}
function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  return "{" + Object.keys(value).sort().map(key => JSON.stringify(key) + ":" + canonical(value[key])).join(",") + "}";
}
function bytes(value) { return Buffer.from(canonical(value) + "\n", "utf8"); }
function digest(value) { return createHash("sha256").update(value).digest("hex"); }
function sameStat(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode && left.nlink === right.nlink && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}
function isCode(error, code) { return !!error && typeof error === "object" && error.code === code; }

const phaseInput = {
  path: requiredEnv("SQUIRE_PLAN_INPUT_PATH"),
  sha256: requiredEnv("SQUIRE_PLAN_INPUT_SHA256"),
  schemaId: INPUT_SCHEMA,
};
if (!/^(?:artifacts|evidence)\/(?!.*(?:^|\/)\.\.?\/)[^\u0000\s]+$/u.test(phaseInput.path) || phaseInput.path.length > 1024 || path.posix.normalize(phaseInput.path) !== phaseInput.path || phaseInput.path.includes("\\") || !/^[0-9a-f]{64}$/u.test(phaseInput.sha256)) throw new Error("trusted Plan input artifact is invalid");
const context = {
  runId: identifier(requiredEnv("SQUIRE_PLAN_RUN_ID"), "runId", RUN_ID, 128),
  handoffId: identifier(requiredEnv("SQUIRE_PLAN_HANDOFF_ID"), "handoffId", HANDOFF_ID, 128),
  attempt: integerEnv("SQUIRE_PLAN_ATTEMPT"),
  targetSessionId: identifier(requiredEnv("SQUIRE_PLAN_SESSION_ID"), "targetSessionId", SESSION_ID, 200),
  inputHead: identifier(requiredEnv("SQUIRE_PLAN_INPUT_HEAD"), "inputHead", HEAD, 64),
  ticketIdentifier: identifier(requiredEnv("SQUIRE_PLAN_TICKET_IDENTIFIER"), "ticketIdentifier", TICKET_ID, 64),
  completedAt: requiredEnv("SQUIRE_PLAN_COMPLETED_AT"),
  allowedValidationCommandIds: jsonArrayEnv("SQUIRE_PLAN_ALLOWED_VALIDATION_COMMAND_IDS"),
  requiredValidationCommandIds: jsonArrayEnv("SQUIRE_PLAN_REQUIRED_VALIDATION_COMMAND_IDS"),
  ticketRoot: requiredEnv("SQUIRE_TICKET_ROOT"),
};
if (!Number.isFinite(Date.parse(context.completedAt)) || new Date(context.completedAt).toISOString() !== context.completedAt) throw new Error("trusted Plan completion time is invalid");
if (!path.isAbsolute(context.ticketRoot) || path.resolve(context.ticketRoot) !== context.ticketRoot || path.parse(context.ticketRoot).root === context.ticketRoot || context.ticketRoot.includes("\\") || context.ticketRoot.includes("..")) throw new Error("trusted Plan ticket root is unsafe");
if (context.requiredValidationCommandIds.some(id => !context.allowedValidationCommandIds.includes(id))) throw new Error("trusted Plan required command is not allowed");

function trustedRootEnv(name) {
  const value = requiredEnv(name);
  if (!path.isAbsolute(value) || path.resolve(value) !== value || path.parse(value).root === value || value.includes("\\") || value.includes("..")) throw new Error("trusted Plan filesystem root is unsafe: " + name);
  return value;
}
function withinPath(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative));
}
function deniedFilesystemName(name, first) {
  if (first && new Set([".git", "artifacts", "evidence", "runtime", "sessions"]).has(name)) return true;
  return /^(?:\.env(?:\..*)?|auth\.json|credentials?\.json|secrets?\.json|token\.json|.*(?:secret|token|credential|api[_-]?key).*\.json)$/iu.test(name);
}
function filesystemParts(value, field, allowRoot) {
  if (value === undefined && allowRoot) return [];
  const result = text(value, field, MAX.path);
  if (result.startsWith("/") || result.startsWith("\\") || /^[A-Za-z]:/u.test(result) || result.includes("\\") || result.includes("//")) throw new Error(field + " must be a repository-relative path");
  const parts = result === "." && allowRoot ? [] : result.split("/");
  if (parts.some((part, index) => part.length === 0 || part === "." || part === ".." || deniedFilesystemName(part, index === 0))) throw new Error(field + " is outside the Plan read allowlist");
  return parts;
}
function filesystemDisplay(parts) { return parts.length === 0 ? "." : parts.join("/"); }
function filesystemScope(parts) {
  const candidate = path.resolve(workspaceRoot, ...parts);
  const relative = path.relative(wikiRoot, candidate);
  return relative === "" || (!relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative)) ? "project-wiki" : "repository";
}
function fsDirectoryPath(handle) {
  if (process.platform !== "linux" || constants.O_NOFOLLOW === undefined || constants.O_DIRECTORY === undefined) throw new Error("secure descriptor Plan read operations are unsupported on this platform");
  if (!Number.isSafeInteger(handle.fd) || handle.fd < 0) throw new Error("Plan read descriptor is invalid");
  return "/proc/self/fd/" + handle.fd;
}
function fsDescriptorPath(handle, name) {
  if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\\") || CONTROL.test(name) || deniedFilesystemName(name, false)) throw new Error("Plan read path component is unsafe");
  return fsDirectoryPath(handle) + "/" + name;
}
async function checkFilesystemRoot(root, name, optional) {
  if (process.platform !== "linux" || constants.O_NOFOLLOW === undefined || constants.O_DIRECTORY === undefined) throw new Error("secure descriptor Plan read operations are unsupported on this platform");
  try {
    const before = await lstat(root);
    if (!before.isDirectory() || before.isSymbolicLink()) throw new Error("Plan filesystem root is not a directory: " + name);
    if (await realpath(root) !== root) throw new Error("Plan filesystem root has a symbolic-link ancestor: " + name);
    const handle = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      const after = await handle.stat();
      if (!sameStat(before, after)) throw new Error("Plan filesystem root changed during validation: " + name);
      return after;
    } finally { await handle.close(); }
  } catch (error) {
    if (optional && isCode(error, "ENOENT")) return undefined;
    throw error;
  }
}
if (requiredEnv("SQUIRE_PLAN_FILESYSTEM_POLICY_SHA256") !== FS_POLICY_SHA256) throw new Error("trusted Plan filesystem policy digest mismatch");
const workspaceRoot = trustedRootEnv("SQUIRE_PLAN_WORKSPACE_ROOT");
const wikiRoot = trustedRootEnv("SQUIRE_PLAN_WIKI_ROOT");
if (!withinPath(workspaceRoot, wikiRoot) || path.relative(workspaceRoot, wikiRoot) === "") throw new Error("trusted Plan wiki root is outside the workspace");
async function checkConfiguredFilesystemRoots() {
  await checkFilesystemRoot(workspaceRoot, "workspace", false);
  await checkFilesystemRoot(wikiRoot, "project wiki", true);
}
async function openFilesystemRoot() {
  const before = await checkFilesystemRoot(workspaceRoot, "workspace", false);
  const handle = await open(workspaceRoot, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const after = await handle.stat();
    if (!sameStat(before, after)) throw new Error("Plan workspace changed during descriptor open");
    return { handle, before: after, name: undefined, parent: undefined, rootDevice: after.dev };
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}
async function openFilesystemChild(parent, name) {
  const target = fsDescriptorPath(parent.handle, name);
  const before = await lstat(target);
  if (before.isSymbolicLink() || (!before.isDirectory() && !before.isFile())) throw new Error("Plan read target must be a regular file or directory");
  const flags = constants.O_RDONLY | constants.O_NOFOLLOW | (before.isDirectory() ? constants.O_DIRECTORY : 0);
  const handle = await open(target, flags);
  try {
    const after = await handle.stat();
    if (!sameStat(before, after) || String(after.dev) !== String(parent.rootDevice)) throw new Error("Plan read target changed or crossed a filesystem boundary");
    return { handle, before: after, name, parent, rootDevice: parent.rootDevice };
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}
async function openFilesystemTarget(parts, expected) {
  const root = await openFilesystemRoot();
  const chain = [root];
  let current = root;
  try {
    for (let index = 0; index < parts.length; index += 1) {
      const child = await openFilesystemChild(current, parts[index]);
      chain.push(child);
      if (index < parts.length - 1 && !child.before.isDirectory()) throw new Error("Plan read path has a non-directory ancestor");
      current = child;
    }
    if (expected === "file" && (parts.length === 0 || !current.before.isFile())) throw new Error("Plan read target is not a regular file");
    if (expected === "directory" && !current.before.isDirectory()) throw new Error("Plan read target is not a directory");
    if (expected === "any" && parts.length > 0 && !current.before.isFile() && !current.before.isDirectory()) throw new Error("Plan read target has an unsupported type");
    if (expected === "any" && current.before.isFile()) validateFilesystemFile(current.before);
    return { root, handle: current.handle, chain, parts, rootDevice: root.rootDevice };
  } catch (error) {
    for (const entry of chain.reverse()) await entry.handle.close().catch(() => undefined);
    throw error;
  }
}
async function verifyFilesystemTarget(target) {
  for (let index = 0; index < target.chain.length; index += 1) {
    const entry = target.chain[index];
    const current = await entry.handle.stat();
    if (!sameStat(entry.before, current)) throw new Error("Plan read path changed during operation");
    const pathInfo = index === 0 ? await lstat(workspaceRoot) : await lstat(fsDescriptorPath(target.chain[index - 1].handle, entry.name));
    if (!sameStat(entry.before, pathInfo)) throw new Error("Plan read path identity changed during operation");
  }
}
async function closeFilesystemTarget(target) {
  for (const entry of target.chain.slice().reverse()) await entry.handle.close().catch(() => undefined);
}
function validateFilesystemFile(info) {
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > FS_MAX_FILE_BYTES) throw new Error("Plan read target is not a bounded single-link regular file");
}
async function readFilesystemBytes(target) {
  const before = await target.handle.stat();
  validateFilesystemFile(before);
  // Test-only delay gives the adversarial suite a deterministic mutation window;
  // the controller never supplies this variable and it cannot weaken checks.
  const testDelay = process.env.NODE_ENV === "test" ? process.env.SQUIRE_PLAN_TEST_ONLY_READ_DELAY_MS : undefined;
  if (testDelay !== undefined) {
    if (!/^[0-9]{1,4}$/u.test(testDelay)) throw new Error("Plan test-only read delay is invalid");
    await new Promise(resolve => setTimeout(resolve, Number(testDelay)));
  }
  const result = Buffer.allocUnsafe(before.size);
  let offset = 0;
  while (offset < result.length) {
    const read = await target.handle.read(result, offset, Math.min(FS_READ_CHUNK_BYTES, result.length - offset), offset);
    if (read.bytesRead <= 0) throw new Error("Plan read ended before the stable file size");
    offset += read.bytesRead;
    await new Promise(resolve => setImmediate(resolve));
  }
  const after = await target.handle.stat();
  if (!sameStat(before, after)) throw new Error("Plan file changed during read");
  await verifyFilesystemTarget(target);
  return { bytes: result, sha256: digest(result) };
}
async function directoryEntries(target) {
  const before = await target.handle.stat();
  if (!before.isDirectory()) throw new Error("Plan list target is not a directory");
  const entries = await readdir(fsDirectoryPath(target.handle), { withFileTypes: true });
  if (entries.length > FS_MAX_ENTRIES) throw new Error("Plan directory exceeds its entry bound");
  const result = [];
  for (const entry of entries) {
    if (deniedFilesystemName(entry.name, target.parts.length === 0)) continue;
    const child = await openFilesystemChild(target, entry.name);
    try {
      const info = child.before;
      if (info.isFile()) validateFilesystemFile(info);
      else if (!info.isDirectory()) throw new Error("Plan directory contains an unsupported entry type");
      result.push({ name: entry.name, type: info.isDirectory() ? "directory" : "file", size: info.isFile() ? info.size : undefined });
    } finally { await child.handle.close().catch(() => undefined); }
  }
  await verifyFilesystemTarget(target);
  return result.sort((left, right) => left.name.localeCompare(right.name));
}
function fsObject(value, field, allowed) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(field + " must be an object");
  if (allowed && Object.keys(value).some(key => !allowed.has(key))) throw new Error(field + " contains an unknown field");
  return value;
}
function fsInteger(value, field, fallback, max) {
  const result = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(result) || result < 1 || result > max) throw new Error(field + " is outside its bound");
  return result;
}
function fsBoolean(value, field, fallback) {
  const result = value === undefined ? fallback : value;
  if (typeof result !== "boolean") throw new Error(field + " must be boolean");
  return result;
}
function fsResult(message, details) {
  if (Buffer.byteLength(message, "utf8") > FS_MAX_OUTPUT_BYTES) throw new Error("Plan filesystem output exceeds its bound");
  return { content: [{ type: "text", text: message }], details: { policy: FS_POLICY_ID, policyDigest: FS_POLICY_SHA256, inputHead: context.inputHead, ...details } };
}
function escapedRegex(value) { return value.replace(/[|\\{}()[\]^$+*?.]/gu, "\\$&"); }
function globRegex(value) {
  let source = "^";
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === "*") source += value[index + 1] === "*" ? (index += 1, ".*") : "[^/]*";
    else if (character === "?") source += "[^/]";
    else source += escapedRegex(character);
  }
  return new RegExp(source + "$", "u");
}
async function walkFilesystemFiles(target, relativeParts, visit, state, depth) {
  if (state.stop) return;
  const info = await target.handle.stat();
  if (info.isFile()) {
    validateFilesystemFile(info);
    state.files += 1;
    if (state.files > FS_MAX_FILES) throw new Error("Plan search exceeds its file bound");
    await visit(target, relativeParts);
    await verifyFilesystemTarget(target);
    return;
  }
  if (!info.isDirectory()) throw new Error("Plan search target has an unsupported type");
  if (depth >= FS_MAX_DEPTH) {
    await verifyFilesystemTarget(target);
    return;
  }
  const entries = await directoryEntries(target);
  for (const entry of entries) {
    const child = await openFilesystemChild(target, entry.name);
    const childTarget = { root: target.root, handle: child.handle, chain: target.chain.concat(child), parts: relativeParts.concat(entry.name), rootDevice: target.rootDevice };
    try { await walkFilesystemFiles(childTarget, relativeParts.concat(entry.name), visit, state, depth + 1); }
    finally { await child.handle.close().catch(() => undefined); }
  }
  await verifyFilesystemTarget(target);
}
async function runPlanRead(input) {
  const value = fsObject(input, "read input", new Set(["path", "offset", "limit"]));
  const parts = filesystemParts(value.path, "path", false);
  const offset = fsInteger(value.offset, "offset", 1, 1_000_000);
  const limit = fsInteger(value.limit, "limit", 2_000, 2_000);
  const target = await openFilesystemTarget(parts, "file");
  try {
    const read = await readFilesystemBytes(target);
    const lines = read.bytes.toString("utf8").split(/\r?\n/u);
    const selected = lines.slice(offset - 1, offset - 1 + limit);
    return fsResult(selected.join("\n"), { path: filesystemDisplay(parts), scope: filesystemScope(parts), sha256: read.sha256, offset, limit });
  } finally { await closeFilesystemTarget(target); }
}
async function runPlanGrep(input) {
  const value = fsObject(input, "grep input", new Set(["path", "pattern", "literal", "ignoreCase", "maxResults"]));
  const parts = filesystemParts(value.path === undefined ? "." : value.path, "path", true);
  const pattern = text(value.pattern, "pattern", 512);
  const literal = fsBoolean(value.literal, "literal", true);
  const ignoreCase = fsBoolean(value.ignoreCase, "ignoreCase", false);
  const maxResults = fsInteger(value.maxResults, "maxResults", 200, 1_000);
  let matcher;
  try { matcher = new RegExp(literal ? escapedRegex(pattern) : pattern, ignoreCase ? "iu" : "u"); }
  catch { throw new Error("grep pattern is not a valid bounded expression"); }
  const target = await openFilesystemTarget(parts, "any");
  const matches = [];
  const state = { files: 0, stop: false };
  try {
    await walkFilesystemFiles(target, parts, async (file, relativeParts) => {
      const read = await readFilesystemBytes(file);
      const lines = read.bytes.toString("utf8").split(/\r?\n/u);
      for (let index = 0; index < lines.length; index += 1) {
        if (!matcher.test(lines[index])) continue;
        matches.push(filesystemDisplay(relativeParts) + ":" + (index + 1) + ":" + lines[index].slice(0, 4_096));
        if (matches.length >= maxResults) { state.stop = true; return; }
      }
    }, state, 0);
    return fsResult(matches.join("\n"), { path: filesystemDisplay(parts), scope: filesystemScope(parts), pattern, literal, ignoreCase, truncated: matches.length >= maxResults, matches: matches.length });
  } finally { await closeFilesystemTarget(target); }
}
async function runPlanFind(input) {
  const value = fsObject(input, "find input", new Set(["path", "pattern", "maxDepth", "maxResults"]));
  const parts = filesystemParts(value.path === undefined ? "." : value.path, "path", true);
  const pattern = value.pattern === undefined ? "**" : text(value.pattern, "pattern", MAX.path);
  const maxDepth = fsInteger(value.maxDepth, "maxDepth", FS_MAX_DEPTH, FS_MAX_DEPTH);
  const maxResults = fsInteger(value.maxResults, "maxResults", 2_000, FS_MAX_ENTRIES);
  const matcher = globRegex(pattern);
  const target = await openFilesystemTarget(parts, "any");
  const found = [];
  async function visit(current, relativeParts, depth) {
    const info = await current.handle.stat();
    if (info.isFile()) validateFilesystemFile(info);
    const display = filesystemDisplay(relativeParts);
    if (matcher.test(display) && found.length < maxResults) found.push({ path: display, type: info.isDirectory() ? "directory" : "file", size: info.isFile() ? info.size : undefined });
    if (!info.isDirectory()) {
      await verifyFilesystemTarget(current);
      return;
    }
    if (depth >= maxDepth || found.length >= maxResults) {
      await verifyFilesystemTarget(current);
      return;
    }
    const entries = await directoryEntries(current);
    for (const entry of entries) {
      const child = await openFilesystemChild(current, entry.name);
      const childTarget = { root: target.root, handle: child.handle, chain: current.chain.concat(child), parts: relativeParts.concat(entry.name), rootDevice: target.rootDevice };
      try { await visit(childTarget, relativeParts.concat(entry.name), depth + 1); }
      finally { await child.handle.close().catch(() => undefined); }
      if (found.length >= maxResults) break;
    }
    await verifyFilesystemTarget(current);
  }
  try {
    await visit(target, parts, 0);
    const lines = found.map(item => item.path + "\t" + item.type + (item.size === undefined ? "" : "\t" + item.size));
    return fsResult(lines.join("\n"), { path: filesystemDisplay(parts), scope: filesystemScope(parts), pattern, maxDepth, truncated: found.length >= maxResults, entries: found.length });
  } finally { await closeFilesystemTarget(target); }
}
async function runPlanLs(input) {
  const value = fsObject(input, "ls input", new Set(["path"]));
  const parts = filesystemParts(value.path, "path", true);
  const target = await openFilesystemTarget(parts, "directory");
  try {
    const entries = await directoryEntries(target);
    const lines = entries.map(entry => entry.name + "\t" + entry.type + (entry.size === undefined ? "" : "\t" + entry.size));
    return fsResult(lines.join("\n"), { path: filesystemDisplay(parts), scope: filesystemScope(parts), entries: entries.length });
  } finally { await closeFilesystemTarget(target); }
}

function outputPaths() {
  const directory = "artifacts/plan/" + context.attempt;
  const evidenceDirectory = "evidence/plan/" + context.attempt;
  return new Set([directory + "/plan.json", directory + "/result.json", evidenceDirectory + "/verification.md"]);
}
function assertOutputPath(relative) {
  if (!outputPaths().has(relative) || relative.includes("\\") || relative.includes("\u0000")) throw new Error("Plan output path is not fixed");
}
function descriptorPath(directory, name) {
  if (process.platform !== "linux" || constants.O_NOFOLLOW === undefined || constants.O_DIRECTORY === undefined) throw new Error("secure descriptor Plan output operations are unsupported on this platform");
  if (!Number.isSafeInteger(directory.fd) || directory.fd < 0 || !name || name === "." || name === ".." || name.includes("/") || name.includes("\\") || CONTROL.test(name)) throw new Error("Plan output path component is unsafe");
  return "/proc/self/fd/" + directory.fd + "/" + name;
}
async function openOutputDirectory(root, directory) {
  if (process.platform !== "linux" || constants.O_NOFOLLOW === undefined || constants.O_DIRECTORY === undefined) throw new Error("secure descriptor Plan output operations are unsupported on this platform");
  const canonicalRoot = await realpath(root);
  if (canonicalRoot !== root) throw new Error("Plan ticket root has a symbolic-link ancestor");
  const rootPathInfo = await lstat(root);
  const rootHandle = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  let current = rootHandle;
  try {
    const openedRoot = await rootHandle.stat();
    if (!sameStat(openedRoot, rootPathInfo)) throw new Error("Plan ticket root changed during descriptor open");
    const relative = path.relative(root, directory);
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Plan output escaped ticket root");
    for (const part of relative.split(path.sep).filter(Boolean)) {
      if (part === "." || part === ".." || CONTROL.test(part)) throw new Error("Plan output directory is unsafe");
      let next;
      try { next = await open(descriptorPath(current, part), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); }
      catch (error) {
        if (!isCode(error, "ENOENT")) throw error;
        try { await mkdir(descriptorPath(current, part), { mode: 0o700 }); }
        catch (mkdirError) { if (!isCode(mkdirError, "EEXIST")) throw mkdirError; }
        await current.sync();
        next = await open(descriptorPath(current, part), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      }
      try {
        const info = await next.stat();
        if (!info.isDirectory() || (info.mode & 0o777) !== 0o700 || String(info.dev) !== String(openedRoot.dev)) throw new Error("Plan output directory is not a private same-filesystem directory");
      } catch (error) {
        await next.close();
        throw error;
      }
      if (current !== rootHandle) await current.close();
      current = next;
    }
    return current;
  } catch (error) {
    await current.close().catch(() => undefined);
    throw error;
  }
}
async function readExisting(parent, name, expected) {
  const target = descriptorPath(parent, name);
  const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || (before.mode & 0o777) !== 0o600 || before.size > MAX_OUTPUT_BYTES) throw new Error("existing Plan output is not a bounded private file");
    const result = Buffer.allocUnsafe(before.size);
    let offset = 0;
    while (offset < result.length) {
      const read = await handle.read(result, offset, result.length - offset, offset);
      if (read.bytesRead <= 0) throw new Error("existing Plan output ended during read");
      offset += read.bytesRead;
    }
    const after = await handle.stat();
    if (!sameStat(before, after)) throw new Error("existing Plan output changed during read");
    const canonicalRoot = await realpath(path.resolve(context.ticketRoot));
    const canonicalTarget = await realpath(target);
    if (canonicalTarget !== canonicalRoot && !canonicalTarget.startsWith(canonicalRoot + path.sep)) throw new Error("existing Plan output escaped ticket root");
    const targetAfter = await lstat(target);
    if (!sameStat(after, targetAfter)) throw new Error("existing Plan output identity changed");
    if (!result.equals(expected)) throw new Error("immutable Plan output conflict");
    return result;
  } finally { await handle.close(); }
}
async function writeImmutable(relative, value) {
  assertOutputPath(relative);
  const root = path.resolve(context.ticketRoot);
  const parts = relative.split("/");
  const directory = path.join(root, ...parts.slice(0, -1));
  const name = parts[parts.length - 1];
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value);
  if (buffer.length > MAX_OUTPUT_BYTES) throw new Error("Plan output exceeds its size bound");
  const parent = await openOutputDirectory(root, directory);
  try {
    const target = descriptorPath(parent, name);
    try {
      const handle = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try {
        let offset = 0;
        while (offset < buffer.length) {
          const written = await handle.write(buffer, offset, buffer.length - offset, offset);
          if (written.bytesWritten <= 0) throw new Error("Plan output write made no progress");
          offset += written.bytesWritten;
        }
        const info = await handle.stat();
        if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o777) !== 0o600 || info.size !== buffer.length) throw new Error("new Plan output is not a private regular file");
        await handle.sync();
      } finally { await handle.close(); }
    } catch (error) {
      if (!isCode(error, "EEXIST")) throw error;
      await readExisting(parent, name, buffer);
    }
    await parent.sync();
    return { path: relative, sha256: digest(buffer) };
  } finally { await parent.close(); }
}
function validateSubmission(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Plan submission must be an object");
  const allowed = new Set(["disposition", "schemaVersion", "runId", "ticketIdentifier", "inputHead", "summary", "assumptions", "steps", "risks", "validationCommandIds", "questions"]);
  if (Object.keys(input).some(key => !allowed.has(key))) throw new Error("Plan submission contains an unknown field");
  if (input.disposition !== "pass" && input.disposition !== "blocked") throw new Error("Plan disposition is invalid");
  const disposition = input.disposition;
  if (input.schemaVersion !== 1 || input.runId !== context.runId || input.ticketIdentifier !== context.ticketIdentifier || input.inputHead !== context.inputHead) throw new Error("Plan identity is not controller-bound");
  const summary = text(input.summary, "summary", MAX.summary);
  const assumptions = array(input.assumptions, "assumptions", MAX.assumptions).map((item, index) => {
    const assumption = text(item, "assumptions[" + index + "]", MAX.assumption);
    if (disposition === "pass" && UNRESOLVED.test(assumption)) throw new Error("Plan pass contains an unresolved assumption");
    return assumption;
  });
  const steps = array(input.steps, "steps", MAX.steps);
  if (steps.length === 0) throw new Error("Plan requires a step");
  const normalizedSteps = steps.map((step, index) => {
    if (!step || typeof step !== "object" || Array.isArray(step) || Object.keys(step).some(key => !["id", "description", "affectedPaths", "acceptanceCriteria"].includes(key))) throw new Error("invalid Plan step");
    const id = identifier(step.id, "steps[" + index + "].id", STEP_ID, 128);
    if (id !== "step-" + (index + 1)) throw new Error("Plan steps must be ordered and contiguous");
    const description = text(step.description, "steps[" + index + "].description", MAX.stepDescription);
    const affectedPaths = array(step.affectedPaths, "steps[" + index + "].affectedPaths", MAX.pathsPerStep).map((item, pathIndex) => pathValue(item, "steps[" + index + "].affectedPaths[" + pathIndex + "]"));
    if (affectedPaths.length === 0 || new Set(affectedPaths).size !== affectedPaths.length) throw new Error("Plan affected paths are invalid");
    const acceptanceCriteria = array(step.acceptanceCriteria, "steps[" + index + "].acceptanceCriteria", MAX.criteriaPerStep).map((item, criterionIndex) => actionable(item, "steps[" + index + "].acceptanceCriteria[" + criterionIndex + "]", MAX.criterion));
    if (acceptanceCriteria.length === 0) throw new Error("Plan steps require acceptance criteria");
    return { id, description, affectedPaths, acceptanceCriteria };
  });
  const risks = array(input.risks, "risks", MAX.risks).map((risk, index) => {
    if (!risk || typeof risk !== "object" || Array.isArray(risk) || Object.keys(risk).some(key => !["risk", "mitigation"].includes(key))) throw new Error("invalid Plan risk");
    return { risk: text(risk.risk, "risks[" + index + "].risk", MAX.risk), mitigation: text(risk.mitigation, "risks[" + index + "].mitigation", MAX.mitigation) };
  });
  const validationCommandIds = array(input.validationCommandIds, "validationCommandIds", MAX.validationIds).map((id, index) => identifier(id, "validationCommandIds[" + index + "]", COMMAND_ID, 64));
  if (validationCommandIds.length === 0 || new Set(validationCommandIds).size !== validationCommandIds.length || validationCommandIds.some(id => !context.allowedValidationCommandIds.includes(id))) throw new Error("Plan validation command ids are invalid or not allowed");
  if (disposition === "pass" && context.requiredValidationCommandIds.some(id => !validationCommandIds.includes(id))) throw new Error("Plan omits a required validation command");
  const questions = input.questions === undefined ? [] : array(input.questions, "questions", MAX.questions).map((question, index) => actionable(question, "questions[" + index + "]", MAX.question));
  if (disposition === "blocked" && questions.length === 0) throw new Error("blocked Plan requires actionable questions");
  if (disposition === "blocked" && !/\b(?:blocked|must not start|cannot proceed)\b/iu.test(summary)) throw new Error("blocked Plan must state that implementation must not start");
  if (disposition === "pass" && questions.length > 0) throw new Error("pass Plan cannot contain blocking questions");
  return { disposition, summary, assumptions, steps: normalizedSteps, risks, validationCommandIds, questions };
}
async function publish(input) {
  const submission = validateSubmission(input);
  const plan = { schemaVersion: 1, runId: context.runId, ticketIdentifier: context.ticketIdentifier, inputHead: context.inputHead, summary: submission.summary, assumptions: submission.assumptions, steps: submission.steps, risks: submission.risks, validationCommandIds: submission.validationCommandIds };
  const planFile = await writeImmutable("artifacts/plan/" + context.attempt + "/plan.json", bytes(plan));
  const questionText = submission.questions.length === 0 ? "none" : submission.questions.map((question, index) => (index + 1) + ". " + question).join("\n");
  const report = ["# Plan verification", "", "- runId: " + context.runId, "- handoffId: " + context.handoffId, "- attempt: " + context.attempt, "- inputHead: " + context.inputHead, "- inputArtifact: " + phaseInput.path + " (sha256:" + phaseInput.sha256 + ")", "- planArtifact: " + planFile.path + " (sha256:" + planFile.sha256 + ")", "- disposition: " + submission.disposition, "- questions: " + questionText, ""].join("\n");
  const reportFile = await writeImmutable("evidence/plan/" + context.attempt + "/verification.md", Buffer.from(report, "utf8"));
  const result = {
    schemaVersion: 1,
    handoffId: context.handoffId,
    inputArtifact: phaseInput,
    runId: context.runId,
    phase: "plan",
    sessionId: context.targetSessionId,
    inputHead: context.inputHead,
    outputHead: context.inputHead,
    status: submission.disposition === "pass" ? "pass" : "failed",
    artifacts: [{ path: planFile.path, sha256: planFile.sha256, mediaType: "application/json", schemaId: PLAN_SCHEMA }],
    evidence: [{ path: reportFile.path, sha256: reportFile.sha256, mediaType: "text/markdown", kind: "report" }],
    findings: [],
    failures: submission.disposition === "pass" ? [] : [{ id: "PLAN_CONTEXT_BLOCKED", category: "policy", blocking: true, summary: "Plan blocked: " + submission.questions.join(" | ") }],
    requestedTransition: submission.disposition === "pass" ? { toState: "implementing", reason: "phase_pass" } : { toState: "failed", reason: "phase_failed" },
    completedAt: context.completedAt,
  };
  const resultFile = await writeImmutable("artifacts/plan/" + context.attempt + "/result.json", bytes(result));
  return { plan: planFile, report: reportFile, result: { path: resultFile.path, sha256: resultFile.sha256, schemaId: RESULT_SCHEMA } };
}
const readParameters = {
  type: "object",
  additionalProperties: false,
  required: ["path"],
  properties: { path: { type: "string", minLength: 1, maxLength: MAX.path }, offset: { type: "integer", minimum: 1, maximum: 1_000_000 }, limit: { type: "integer", minimum: 1, maximum: 2_000 } },
};
const grepParameters = {
  type: "object",
  additionalProperties: false,
  required: ["pattern"],
  properties: { path: { type: "string", minLength: 1, maxLength: MAX.path }, pattern: { type: "string", minLength: 1, maxLength: 512 }, literal: { type: "boolean" }, ignoreCase: { type: "boolean" }, maxResults: { type: "integer", minimum: 1, maximum: 1_000 } },
};
const findParameters = {
  type: "object",
  additionalProperties: false,
  properties: { path: { type: "string", minLength: 1, maxLength: MAX.path }, pattern: { type: "string", minLength: 1, maxLength: MAX.path }, maxDepth: { type: "integer", minimum: 1, maximum: FS_MAX_DEPTH }, maxResults: { type: "integer", minimum: 1, maximum: FS_MAX_ENTRIES } },
};
const lsParameters = {
  type: "object",
  additionalProperties: false,
  required: ["path"],
  properties: { path: { type: "string", minLength: 1, maxLength: MAX.path } },
};
const filesystemTools = [
  {
    name: PATH_TOOL_NAMES[0],
    label: "Read repository file",
    description: "Read bounded text from a repository-relative regular file; absolute paths and path traversal are denied.",
    promptSnippet: "Read a repository-relative source or project-wiki file",
    promptGuidelines: ["Use repository-relative paths only.", "Do not request controller artifacts, sessions, runtime files, auth files, or symlinks."],
    parameters: readParameters,
    async execute(_toolCallId, input) { await checkConfiguredFilesystemRoots(); return runPlanRead(input); },
  },
  {
    name: PATH_TOOL_NAMES[1],
    label: "Search repository files",
    description: "Search bounded repository-relative files without shell access or absolute-path access.",
    promptSnippet: "Search repository-relative source and project-wiki files",
    promptGuidelines: ["Use repository-relative paths only.", "Search is bounded and fails closed on links, hardlinks, special files, or races."],
    parameters: grepParameters,
    async execute(_toolCallId, input) { await checkConfiguredFilesystemRoots(); return runPlanGrep(input); },
  },
  {
    name: PATH_TOOL_NAMES[2],
    label: "Find repository paths",
    description: "List bounded repository-relative files and directories without following links or exposing controller paths.",
    promptSnippet: "Find repository-relative source or project-wiki paths",
    promptGuidelines: ["Use repository-relative paths only.", "Results never contain absolute paths."],
    parameters: findParameters,
    async execute(_toolCallId, input) { await checkConfiguredFilesystemRoots(); return runPlanFind(input); },
  },
  {
    name: PATH_TOOL_NAMES[3],
    label: "List repository directory",
    description: "List one bounded repository-relative directory without following links or exposing controller paths.",
    promptSnippet: "List a repository-relative source or project-wiki directory",
    promptGuidelines: ["Use repository-relative paths only.", "Results never contain absolute paths."],
    parameters: lsParameters,
    async execute(_toolCallId, input) { await checkConfiguredFilesystemRoots(); return runPlanLs(input); },
  },
];
const parameters = ${JSON.stringify({
    type: "object",
    additionalProperties: false,
    required: ["disposition", "schemaVersion", "runId", "ticketIdentifier", "inputHead", "summary", "assumptions", "steps", "risks", "validationCommandIds"],
    properties: {
      disposition: { enum: ["pass", "blocked"] },
      schemaVersion: { const: 1 },
      runId: { type: "string", pattern: "^run_[A-Za-z0-9][A-Za-z0-9._-]{0,127}$", maxLength: 128 },
      ticketIdentifier: { type: "string", pattern: "^[A-Z][A-Z0-9]+-[1-9][0-9]*$", maxLength: 64 },
      inputHead: { type: "string", pattern: "^(?:[0-9a-f]{40}|[0-9a-f]{64})$" },
      summary: { type: "string", minLength: 1, maxLength: PLAN_TOOL_MAX.summary },
      assumptions: { type: "array", maxItems: PLAN_TOOL_MAX.assumptions, items: { type: "string", minLength: 1, maxLength: PLAN_TOOL_MAX.assumption } },
      steps: { type: "array", minItems: 1, maxItems: PLAN_TOOL_MAX.steps, items: { type: "object", additionalProperties: false, required: ["id", "description", "affectedPaths", "acceptanceCriteria"], properties: { id: { type: "string", pattern: "^step-[1-9][0-9]*$", maxLength: 128 }, description: { type: "string", minLength: 1, maxLength: PLAN_TOOL_MAX.stepDescription }, affectedPaths: { type: "array", minItems: 1, maxItems: PLAN_TOOL_MAX.pathsPerStep, items: { type: "string", minLength: 1, maxLength: PLAN_TOOL_MAX.path } }, acceptanceCriteria: { type: "array", minItems: 1, maxItems: PLAN_TOOL_MAX.criteriaPerStep, items: { type: "string", minLength: 1, maxLength: PLAN_TOOL_MAX.criterion } } } } },
      risks: { type: "array", maxItems: PLAN_TOOL_MAX.risks, items: { type: "object", additionalProperties: false, required: ["risk", "mitigation"], properties: { risk: { type: "string", minLength: 1, maxLength: PLAN_TOOL_MAX.risk }, mitigation: { type: "string", minLength: 1, maxLength: PLAN_TOOL_MAX.mitigation } } } },
      validationCommandIds: { type: "array", minItems: 1, maxItems: PLAN_TOOL_MAX.validationIds, items: { type: "string", pattern: "^[a-z][a-z0-9_-]{0,63}$" } },
      questions: { type: "array", maxItems: PLAN_TOOL_MAX.questions, items: { type: "string", minLength: 1, maxLength: PLAN_TOOL_MAX.question } },
    },
  }, null, 2)};
let submitted = false;
const planTool = {
  name: TOOL,
  label: "Submit implementation plan",
  description: "Publish one immutable controller-bound Plan outcome and terminate the session.",
  promptSnippet: "Submit exactly one pass or blocked implementation plan",
  promptGuidelines: ["Call exactly once after inspection.", "Use blocked with actionable questions when context is insufficient.", "Do not provide paths or substitute controller identities."],
  parameters,
  async execute(_toolCallId, params) {
    if (submitted) throw new Error("Plan submission tool may be called only once per session");
    submitted = true;
    const published = await publish(params);
    return { content: [{ type: "text", text: params.disposition === "pass" ? "Plan published; the session is complete." : "Plan blocked; implementation must not start." }], details: published, terminate: true };
  },
};
export default function (pi) { for (const tool of filesystemTools) pi.registerTool(tool); pi.registerTool(planTool); }
`;
}

export const PLAN_TOOL_PARAMETERS = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["disposition", "schemaVersion", "runId", "ticketIdentifier", "inputHead", "summary", "assumptions", "steps", "risks", "validationCommandIds"],
  properties: {
    disposition: { enum: ["pass", "blocked"] },
    schemaVersion: { const: 1 },
    runId: { type: "string", pattern: "^run_[A-Za-z0-9][A-Za-z0-9._-]{0,127}$", minLength: 1, maxLength: 128 },
    ticketIdentifier: { type: "string", pattern: "^[A-Z][A-Z0-9]+-[1-9][0-9]*$", minLength: 1, maxLength: 64 },
    inputHead: { type: "string", pattern: "^(?:[0-9a-f]{40}|[0-9a-f]{64})$" },
    summary: { type: "string", minLength: 1, maxLength: PLAN_TOOL_MAX.summary },
    assumptions: { type: "array", maxItems: PLAN_TOOL_MAX.assumptions, items: { type: "string", minLength: 1, maxLength: PLAN_TOOL_MAX.assumption } },
    steps: {
      type: "array",
      minItems: 1,
      maxItems: PLAN_TOOL_MAX.steps,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "description", "affectedPaths", "acceptanceCriteria"],
        properties: {
          id: { type: "string", pattern: "^step-[1-9][0-9]*$", minLength: 1, maxLength: 128 },
          description: { type: "string", minLength: 1, maxLength: PLAN_TOOL_MAX.stepDescription },
          affectedPaths: { type: "array", minItems: 1, maxItems: PLAN_TOOL_MAX.pathsPerStep, items: { type: "string", minLength: 1, maxLength: PLAN_TOOL_MAX.path } },
          acceptanceCriteria: { type: "array", minItems: 1, maxItems: PLAN_TOOL_MAX.criteriaPerStep, items: { type: "string", minLength: 1, maxLength: PLAN_TOOL_MAX.criterion } },
        },
      },
    },
    risks: {
      type: "array",
      maxItems: PLAN_TOOL_MAX.risks,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["risk", "mitigation"],
        properties: {
          risk: { type: "string", minLength: 1, maxLength: PLAN_TOOL_MAX.risk },
          mitigation: { type: "string", minLength: 1, maxLength: PLAN_TOOL_MAX.mitigation },
        },
      },
    },
    validationCommandIds: { type: "array", minItems: 1, maxItems: PLAN_TOOL_MAX.validationIds, items: { type: "string", pattern: "^[a-z][a-z0-9_-]{0,63}$" } },
    questions: { type: "array", maxItems: PLAN_TOOL_MAX.questions, items: { type: "string", minLength: 1, maxLength: PLAN_TOOL_MAX.question } },
  },
});
