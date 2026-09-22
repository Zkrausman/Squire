import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const run = promisify(execFile);
const root = process.cwd();
const helper = path.resolve("skills/squire-bug-report/bug-report.mjs");

function environment(home: string, sessionId?: string): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home };
  if (sessionId === undefined) delete result["PI_SESSION_ID"];
  else result["PI_SESSION_ID"] = sessionId;
  return result;
}

async function invoke(home: string, sessionId: string | undefined, args: string[]) {
  try {
    return await run(process.execPath, [helper, ...args], { cwd: process.cwd(), env: environment(home, sessionId) });
  } catch (error) {
    const failure = error as { message?: string; stderr?: string };
    throw new Error(`${failure.message ?? "helper failed"}\n${failure.stderr ?? ""}`);
  }
}

test("bug report helper binds the session, creates exact exclusive reports, and lists metadata only", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "squire-bug-report-"));
  const home = path.join(root, "home");
  const sessionId = "pi-session-for-test";
  const context = "Observed: command failed. Expected: command succeeds. IDs: AIDEV-319/run-test. Impact: triage is delayed.";
  try {
    const first = JSON.parse((await invoke(home, sessionId, ["create", "--reason", "unexpected command failure", "--context", context])).stdout) as { filename: string; id: string; createdAt: string; sessionId: string };
    assert.equal(typeof first.filename, "string");
    assert.equal(typeof first.id, "string");
    assert.equal(first.sessionId, sessionId);
    assert.equal(first.createdAt !== undefined, true);
    assert.doesNotMatch(JSON.stringify(first), /triage is delayed/u);

    const inbox = path.join(home, ".squire", "bug-reports", "inbox");
    const names = await readdir(inbox);
    assert.deepEqual(names, [first.filename]);
    const stored = JSON.parse(await readFile(path.join(inbox, first.filename), "utf8")) as { version: number; id: string; sessionId: string; reason: string; context: string };
    assert.deepEqual(Object.keys(stored).sort(), ["context", "createdAt", "id", "reason", "sessionId", "version"]);
    assert.equal(stored.version, 1);
    assert.equal(stored.id, first.id);
    assert.equal(stored.sessionId, sessionId);
    assert.equal(stored.reason, "unexpected command failure");
    assert.equal(stored.context, context);
    if (process.platform !== "win32") {
      assert.equal((await stat(inbox)).mode & 0o777, 0o700);
      assert.equal((await stat(path.join(inbox, first.filename))).mode & 0o777, 0o600);
    }

    const second = JSON.parse((await invoke(home, sessionId, ["create", "--reason=second report", "--context=short context"])).stdout) as { filename: string; id: string; createdAt: string; sessionId: string };
    assert.notEqual(second.filename, first.filename);
    const listed = JSON.parse((await invoke(home, sessionId, ["list"])).stdout) as unknown[];
    assert.deepEqual(listed, [
      { filename: first.filename, createdAt: first.createdAt, sessionId, reason: "unexpected command failure" },
      { filename: second.filename, createdAt: second.createdAt, sessionId, reason: "second report" },
    ].sort((left, right) => String(left.filename).localeCompare(String(right.filename))));
    assert.doesNotMatch(JSON.stringify(listed), /Observed:|short context/u);

    await assert.rejects(invoke(home, sessionId, ["create", "--reason", "x", "--context", "y", "--inbox", path.join(root, "outside")]), /unknown option/u);
    assert.equal((await readdir(inbox)).length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bug report helper rejects missing sessions and bounded text", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "squire-bug-report-invalid-"));
  try {
    await assert.rejects(invoke(root, undefined, ["create", "--reason", "reason", "--context", "context"]), /PI_SESSION_ID is required/u);
    await assert.rejects(invoke(root, "session", ["create", "--reason", " ", "--context", "context"]), /reason must not be empty/u);
    await assert.rejects(invoke(root, "session", ["create", "--reason", "r", "--context", "x".repeat(4_001)]), /context exceeds 4000 characters/u);
    await assert.rejects(invoke(root, "session", ["create", "--reason", "x".repeat(501), "--context", "context"]), /reason exceeds 500 characters/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bug report helper resolves the fixed POSIX and Windows profile paths", async () => {
  const module = await import(pathToFileURL(helper).href);
  assert.equal(module.inboxDirectory("posix", { HOME: "/home/ada" }), "/home/ada/.squire/bug-reports/inbox");
  assert.equal(module.inboxDirectory("win32", { USERPROFILE: "C:\\Users\\Ada" }), "C:\\Users\\Ada\\.squire\\bug-reports\\inbox");
});

test("bug-report skill defines the bounded semantic auto-report decision", async () => {
  const skill = await readFile(path.join(root, "skills/squire-bug-report/SKILL.md"), "utf8");
  assert.match(skill, /whenever you encounter or strongly suspect a bug in Squire\s+itself/iu);
  assert.match(skill, /before ending the turn/u);
  assert.match(skill, /ordinary target-repository failures/u);
  assert.match(skill, /expected behavior/u);
  assert.match(skill, /user error/u);
  assert.match(skill, /duplicate/u);
  assert.match(skill, /Do not claim deterministic bug detection/u);
  assert.match(skill, /reason.*context.*required|both are required/su);
  assert.match(skill, /PI_SESSION_ID/u);
  assert.match(skill, /local inbox capture/u);
  assert.match(skill, /not ticket\s+creation/u);
  assert.match(skill, /does not contact Linear or GitHub/u);
});
