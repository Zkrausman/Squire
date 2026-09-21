import type { PersonalRunState, PhaseInput, PersonalPhase } from "../src/personal/types.js";
import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { readFile, writeFile, rm, chmod, symlink, lstat } from "node:fs/promises";
import path from "node:path";
import { TelemetryStore, invocation, validateRunTelemetry, formatTelemetry } from "../src/personal/telemetry-store.js";
import { captureInvocation } from "../src/personal/telemetry-capture.js";
import { parseArguments } from "../src/personal/cli.js";
import { CommandExecutionError } from "../src/personal/command.js";
import { launchTestRoot, assertProtectedAcl, grant } from "./helpers/windows-launch.js";
import { piJson, fixtureProfile as profile } from "./helpers/pi-json.js";
const runId = "aidev-299-telemetry01";
const base = "a".repeat(40);
const input = (phase: PersonalPhase, attempt = 1): PhaseInput => ({ runId, phase, attempt, profile, expectedHead: base, feedback: [], previous: {}, previousCumulative: [] } as unknown as PhaseInput);
const terminal = (overrides: Partial<PersonalRunState> = {}): PersonalRunState => ({ runId, version: 10, status: "completed", startedAt: "2026-01-01T00:00:00.000Z", endedAt: "2026-01-01T00:01:00.000Z", attempts: { plan: 0, implement: 0, review: 0, test: 0, retro: 0 }, results: {}, ...overrides } as PersonalRunState);
async function fixture(fn: (store: TelemetryStore, root: string) => Promise<void>) {
    const root = await launchTestRoot("squire-telemetry-");
    try {
        await fn(new TelemetryStore(root), root);
    }
    finally {
        await rm(root, { recursive: true, force: true });
    }
}
test("six logical sessions reconcile exactly, terminal additive publication is restart-idempotent and private", () => fixture(async (store, root) => {
    for (const [phase, subphase] of [["plan", "requirements"], ["plan", "implementation-design"], ["implement", null], ["review", null], ["test", null], ["retro", null]] as const) {
        const id = randomUUID();
        const start = invocation(input(phase), id, `/ticket/sessions/${phase}/${subphase ?? "1"}.jsonl`, subphase);
        const raw = piJson("PROMPT SECRET RESPONSE SOURCE ENV=SECRET /credentials command", id);
        await captureInvocation(store, start, { async run() { assert.ok(await readFile(path.join(store.directory(runId), `${id}.start.json`))); return { stdout: raw.toString(), stdoutBytes: raw, stderr: "" }; } }, { command: "fake", args: [] });
        await store.settle(runId, id, "passed");
    }
    const state = terminal({ planExecution: "supervised-v1", attempts: { plan: 1, implement: 1, review: 1, test: 1, retro: 1 } });
    const artifact = await store.finalize(state);
    assert.equal(artifact.complete, true);
    assert.equal(artifact.sessions.length, 6);
    assert.equal(artifact.totals.tokens.input.known, 60);
    assert.equal(artifact.totals.recordedCost.known, "0.6");
    assert.equal(artifact.phases[0]!.totals.sessions, 2);
    assert.equal(artifact.phases[0]!.subphases.length, 2);
    assert.equal(artifact.phases.reduce((n, p) => n + p.totals.tokens.input.known, 0), artifact.totals.tokens.input.known);
    assert.equal(artifact.sessions.reduce((n, s) => n + s.durationMs!, 0), artifact.totals.durationMs.known);
    assert.equal(artifact.wallDurationMs, 60000);
    const file = path.join(store.directory(runId), "summary.json");
    const before = await lstat(file);
    assert.deepEqual(await new TelemetryStore(root).finalize(state), artifact);
    assert.equal((await lstat(file)).mtimeMs, before.mtimeMs);
    assert.deepEqual(await store.read(runId), artifact);
    assert.doesNotMatch(await readFile(file, "utf8"), /SECRET|PROMPT|SOURCE|RESPONSE|credentials|ticket\/sessions/u);
    assert.doesNotMatch(formatTelemetry(artifact, runId), /SECRET|PROMPT|SOURCE|RESPONSE|credentials/u);
    if (process.platform === "win32")
        assertProtectedAcl(file);
    else {
        assert.equal(before.mode & 0o777, 0o600);
        assert.equal((await lstat(store.directory(runId))).mode & 0o777, 0o700);
    }
}));
test("model-writable session modification, replacement and deletion cannot change captured totals", () => fixture(async (store, root) => {
    const session = path.join(root, "untrusted-session.jsonl");
    const id = randomUUID();
    const start = invocation(input("implement"), id, session);
    await writeFile(session, "fake transcript");
    await store.begin(start);
    await store.end(start, piJson("PRIVATE", id), true);
    for (const mode of ["modify", "replace", "delete"]) {
        if (mode !== "modify")
            await rm(session, { force: true });
        if (mode !== "delete")
            await writeFile(session, '{"usage":{"input":99999999,"cost":{"total":99999}}}');
        assert.equal((await store.finalize(terminal({ attempts: { plan: 0, implement: 1, review: 0, test: 0, retro: 0 } }))).totals.tokens.input.known, 10);
    }
}));
test("remediation, staged escalation and correction retain every attempt/profile and outcome", () => fixture(async (store) => {
    for (let attempt = 1; attempt <= 3; attempt++) {
        const i: PhaseInput = { ...input("implement", attempt), profile: { ...profile, model: `model-${attempt}` }, escalationDigest: "a".repeat(64), telemetryAttribution: { trigger: attempt === 1 ? "initial" : attempt === 2 ? "remediation" : "stage_advanced", stageIndex: attempt - 1, stageAttempt: 1 } };
        const id = randomUUID(), row = invocation(i, id, `/ticket/sessions/implement/${attempt}.jsonl`);
        await store.begin(row);
        await store.end(row, piJson("PRIVATE", id, i.profile), true);
        await store.settle(runId, id, attempt === 3 ? "passed" : "failed");
    }
    const producer = randomUUID(), row = invocation(input("implement", 3), producer, "/run/private/correction.jsonl", null, 1);
    await store.begin(row);
    await store.end(row, piJson("PRIVATE", producer), true);
    const state = terminal({ attempts: { plan: 0, implement: 3, review: 0, test: 0, retro: 0 }, reportCorrections: [{ kind: "launched", producer }, { kind: "accepted", producer }] as unknown as NonNullable<PersonalRunState["reportCorrections"]> });
    const a = await store.finalize(state);
    assert.equal(a.complete, true);
    assert.equal(a.totals.sessions, 4);
    assert.equal(a.totals.tokens.input.known, 40);
    assert.equal(a.sessions.filter(s => s.trigger === "report-correction").length, 1);
    assert.equal(a.sessions.find(s => s.trigger === "stage_advanced")!.profile.model, "model-3");
    assert.equal(a.sessions.find(s => s.trigger === "remediation")!.outcome, "failed");
    assert.equal(a.sessions.find(s => s.correction)!.outcome, "passed");
}));
test("crash before end, missing start and interrupted child are visibly incomplete, deterministic without current-time endpoints", () => fixture(async (store) => {
    const id = randomUUID(), start = invocation(input("implement"), id, "/ticket/sessions/implement/1.jsonl");
    await store.begin(start);
    const a = await store.finalize(terminal({ status: "interrupted", attempts: { plan: 0, implement: 2, review: 0, test: 0, retro: 0 } }));
    assert.equal(a.complete, false);
    assert.equal(a.inventoryComplete, false);
    assert.equal(a.sessions[0]!.durationMs, null);
    assert.equal(a.sessions[0]!.endedAt, null);
    assert.equal(a.sessions[0]!.usage.tokens.input, null);
    assert.equal(a.totals.tokens.input.complete, false);
    assert.match(formatTelemetry(a, runId), /unknown/u);
    assert.deepEqual(await store.finalize(terminal({ status: "interrupted", attempts: { plan: 0, implement: 2, review: 0, test: 0, retro: 0 } })), a);
}));
test("failed command captures partial bytes without accounting or relabeling outcome", () => fixture(async (store) => {
    const id = randomUUID(), row = invocation(input("test"), id, "/ticket/sessions/test/1.jsonl");
    const bytes = piJson("PRIVATE", id);
    await assert.rejects(captureInvocation(store, row, { async run() { throw new CommandExecutionError("cancelled", "cancelled", "", undefined, bytes); } }, { command: "fake", args: [] }), /cancelled/);
    const a = await store.finalize(terminal({ status: "interrupted", attempts: { plan: 0, implement: 0, review: 0, test: 1, retro: 0 } }));
    assert.equal(a.sessions[0]!.outcome, "interrupted");
    assert.equal(a.sessions[0]!.durationMs, null);
    assert.equal(a.totals.tokens.input.complete, false);
}));
test("telemetry begin/storage failure cannot fail model execution", () => fixture(async (store) => {
    store.begin = async () => { throw new Error("private details"); };
    let called = 0;
    await captureInvocation(store, invocation(input("implement"), randomUUID(), "/session"), { async run() { called++; return { stdout: "", stderr: "" }; } }, { command: "fake", args: [] });
    assert.equal(called, 1);
    const a = await store.finalize(terminal({ attempts: { plan: 0, implement: 1, review: 0, test: 0, retro: 0 } }));
    assert.equal(a.inventoryComplete, false);
    assert.equal(a.complete, false);
}));
test("artifact reader rejects malformed, mismatched, extra/private fields and incorrect reconciled totals", () => fixture(async (store) => {
    const id = randomUUID(), row = invocation(input("implement"), id, "/session");
    await store.begin(row);
    await store.end(row, piJson("PRIVATE", id), true);
    const a = await store.finalize(terminal());
    for (const mutate of [(v: any) => { v.runId = "aidev-299-other123"; }, (v: any) => { v.secret = "SECRET"; }, (v: any) => { v.sessions[0].usage.secret = "SECRET"; }, (v: any) => { v.sessions[0].profile.model = "SECRET\nTOKEN"; }, (v: any) => { v.totals.tokens.input.known++; }, (v: any) => { v.sessions.push(v.sessions[0]); }, (v: any) => { v.sessions[0].durationMs++; }]) {
        const v = structuredClone(a);
        mutate(v);
        assert.throws(() => validateRunTelemetry(v, runId));
    }
    const file = path.join(store.directory(runId), "summary.json");
    await writeFile(file, '{SECRET');
    await assert.rejects(store.read(runId), /invalid or unsafe/u);
}));
test("Unix symlink and public-mode summary rejected; missing legacy summary never scans sessions", { skip: process.platform === "win32" }, () => fixture(async (store, root) => {
    assert.equal(await store.read(runId), undefined);
    assert.match(formatTelemetry(undefined, runId), /unavailable\/incomplete/);
    await store.finalize(terminal());
    const file = path.join(store.directory(runId), "summary.json");
    await chmod(file, 0o644);
    await assert.rejects(store.read(runId));
    await chmod(file, 0o600);
    const bytes = await readFile(file);
    await rm(file);
    const other = path.join(root, "other");
    await writeFile(other, bytes, { mode: 0o600 });
    await symlink(other, file);
    await assert.rejects(store.read(runId));
}));
test("Windows artifact read rejects an added untrusted ACL principal", { skip: process.platform !== "win32" }, () => fixture(async (store) => {
    await store.finalize(terminal());
    const file = path.join(store.directory(runId), "summary.json");
    grant(file, "S-1-5-32-545", "Read");
    await assert.rejects(store.read(runId));
}));
test("CLI grammar is exact-run only, bounded and no backfill/cohort switch exists", () => {
    assert.deepEqual(parseArguments(["telemetry", runId, "--json", "--config", "./custom.json"]), { command: "telemetry", selector: runId, json: true, config: path.resolve("./custom.json") });
    for (const args of [["AIDEV-299"], ["../secret"], [runId, "--json", "--json"], [runId, "--backfill"], [runId, runId], [runId, "--background"]])
        assert.equal(parseArguments(["telemetry", ...args]), undefined);
});

test("raw capture retains exact invalid UTF-8 and NUL bytes privately before accounting rejection", () => fixture(async (store) => {
    const { createReportEvidence, verifyReportEvidence } = await import("../src/personal/report-evidence.js");
    const id = randomUUID(), row = invocation(input("implement"), id, "/ticket/sessions/implement/1.jsonl");
    const bytes = Buffer.from([255, 0, 10, 32]);
    await store.begin(row); await store.end(row, bytes, true);
    const end = JSON.parse(await readFile(path.join(store.directory(runId), `${id}.end.json`), "utf8"));
    const evidence = createReportEvidence(path.join(store.directory(runId), "streams"));
    try { assert.deepEqual(await verifyReportEvidence(evidence, end.streams[0]), bytes); }
    finally { await evidence.release?.(); }
    const artifact = await store.finalize(terminal({ attempts: { plan: 0, implement: 1, review: 0, test: 0, retro: 0 } }));
    assert.equal(artifact.complete, false);
    assert.deepEqual(artifact.sessions[0]!.usage.diagnostics, ["invalid_stream"]);
}));

test("terminal reconciliation recovers exclusive-publication link crash without rewriting summary bytes", { skip: process.platform !== "linux" }, () => fixture(async store => {
    const { link } = await import("node:fs/promises");
    const state = terminal();
    const first = await store.finalize(state);
    const file = path.join(store.directory(runId), "summary.json");
    const temporary = `${file}.${randomUUID()}.tmp`;
    const bytes = await readFile(file);
    await link(file, temporary); // Process died after link but before unlink/fsync.
    await assert.rejects(store.read(runId)); // Read-only command does not repair.
    assert.deepEqual(await store.finalize(state), first);
    assert.deepEqual(await readFile(file), bytes);
    assert.equal((await lstat(file)).nlink, 1);
    await assert.rejects(lstat(temporary), { code: "ENOENT" });
}));
