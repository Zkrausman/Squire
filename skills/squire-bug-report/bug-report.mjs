#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPORT_VERSION = 1;
export const MAX_REASON_CHARS = 500;
export const MAX_CONTEXT_CHARS = 4_000;
export const REPORT_FIELDS = Object.freeze(["version", "id", "createdAt", "sessionId", "reason", "context"]);

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

function characterCount(value) {
  return [...value].length;
}

function boundedText(name, value, maximum) {
  if (typeof value !== "string") throw new Error(`${name} must be text`);
  const normalized = value.trim();
  if (characterCount(normalized) === 0) throw new Error(`${name} must not be empty`);
  if (characterCount(normalized) > maximum) throw new Error(`${name} exceeds ${maximum} characters`);
  return normalized;
}

function sessionFromEnvironment(environment = process.env) {
  const sessionId = environment.PI_SESSION_ID;
  if (typeof sessionId !== "string" || sessionId.trim().length === 0) {
    throw new Error("PI_SESSION_ID is required");
  }
  return sessionId;
}

/** Resolve the fixed per-user inbox; there is intentionally no path override. */
export function inboxDirectory(platform = process.platform, environment = process.env) {
  const home = platform === "win32" ? environment.USERPROFILE : environment.HOME;
  if (typeof home !== "string" || home.length === 0) {
    throw new Error(platform === "win32" ? "USERPROFILE is required" : "HOME is required");
  }
  const join = platform === "win32" ? path.win32.join : path.posix.join;
  return join(home, ".squire", "bug-reports", "inbox");
}

function validateTimestamp(value) {
  if (typeof value !== "string" || !ISO_TIMESTAMP_PATTERN.test(value)) throw new Error("createdAt must be an ISO timestamp");
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== value) throw new Error("createdAt must be an ISO timestamp");
}

/** Validate the closed report object used by both create and list. */
export function validateReport(report) {
  if (report === null || typeof report !== "object" || Array.isArray(report)) throw new Error("report must be an object");
  const keys = Object.keys(report);
  if (keys.length !== REPORT_FIELDS.length || REPORT_FIELDS.some(field => !keys.includes(field))) {
    throw new Error("report fields must be exactly version, id, createdAt, sessionId, reason, and context");
  }
  if (report.version !== REPORT_VERSION) throw new Error("version must be 1");
  if (typeof report.id !== "string" || !UUID_PATTERN.test(report.id)) throw new Error("id must be a UUID");
  validateTimestamp(report.createdAt);
  if (typeof report.sessionId !== "string" || report.sessionId.trim().length === 0) throw new Error("sessionId must not be empty");
  boundedText("reason", report.reason, MAX_REASON_CHARS);
  boundedText("context", report.context, MAX_CONTEXT_CHARS);
  return report;
}

export function createReport(reason, context) {
  const report = {
    version: REPORT_VERSION,
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    sessionId: sessionFromEnvironment(),
    reason: boundedText("reason", reason, MAX_REASON_CHARS),
    context: boundedText("context", context, MAX_CONTEXT_CHARS),
  };
  return validateReport(report);
}

async function ensureInbox(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
}

async function writeExclusive(directory, report) {
  const filename = `${report.id}.json`;
  const filePath = path.join(directory, filename);
  let handle;
  try {
    handle = await open(filePath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    await handle.writeFile(`${JSON.stringify(report)}\n`, "utf8");
  } finally {
    await handle?.close();
  }
  return filename;
}

/** Create exactly one report without replacing an existing file. */
export async function recordReport(reason, context) {
  const firstReport = createReport(reason, context);
  const directory = inboxDirectory();
  await ensureInbox(directory);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const report = attempt === 0 ? firstReport : createReport(reason, context);
    try {
      const filename = await writeExclusive(directory, report);
      return { report, filename };
    } catch (error) {
      if (error?.code !== "EEXIST" || attempt === 4) throw error;
    }
  }
  throw new Error("unable to allocate a unique report filename");
}

function parseStoredReport(filename, bytes) {
  let parsed;
  try {
    parsed = JSON.parse(bytes);
  } catch {
    throw new Error(`invalid JSON in ${filename}`);
  }
  try {
    return validateReport(parsed);
  } catch (error) {
    throw new Error(`invalid report ${filename}: ${error.message}`);
  }
}

/** Return only the metadata allowed by the list mode; context is never returned. */
export async function listReports() {
  const directory = inboxDirectory();
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const reports = [];
  for (const entry of entries.filter(item => item.isFile() && item.name.endsWith(".json")).sort((left, right) => left.name.localeCompare(right.name))) {
    const report = parseStoredReport(entry.name, await readFile(path.join(directory, entry.name), "utf8"));
    reports.push({ filename: entry.name, createdAt: report.createdAt, sessionId: report.sessionId, reason: report.reason });
  }
  return reports;
}

const USAGE = [
  "Usage:",
  "  node bug-report.mjs create --reason <text> --context <text>",
  "  node bug-report.mjs list",
].join("\n");

function optionValue(argv, index, option) {
  const value = argv[index];
  if (value === undefined) throw new Error(`${option} requires a value`);
  return value;
}

function parseCreate(argv) {
  let reason;
  let context;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--reason") {
      if (reason !== undefined) throw new Error("--reason may be supplied once");
      reason = optionValue(argv, ++index, "--reason");
    } else if (argument.startsWith("--reason=")) {
      if (reason !== undefined) throw new Error("--reason may be supplied once");
      reason = argument.slice("--reason=".length);
    } else if (argument === "--context") {
      if (context !== undefined) throw new Error("--context may be supplied once");
      context = optionValue(argv, ++index, "--context");
    } else if (argument.startsWith("--context=")) {
      if (context !== undefined) throw new Error("--context may be supplied once");
      context = argument.slice("--context=".length);
    } else {
      throw new Error(`unknown option: ${argument}`);
    }
  }
  if (reason === undefined || context === undefined) throw new Error("create requires --reason and --context");
  return { reason, context };
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) {
    console.log(USAGE);
    return;
  }
  const command = argv[0];
  if (command === "list") {
    if (argv.length !== 1) throw new Error("list takes no options");
    console.log(JSON.stringify(await listReports()));
    return;
  }
  const createArguments = command === "create" ? argv.slice(1) : argv;
  if (createArguments.length === 0) throw new Error(USAGE);
  const { reason, context } = parseCreate(createArguments);
  const { report, filename } = await recordReport(reason, context);
  console.log(JSON.stringify({ filename, id: report.id, createdAt: report.createdAt, sessionId: report.sessionId }));
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(`bug report: ${error instanceof Error ? error.message : "operation failed"}`);
    process.exitCode = 1;
  });
}
