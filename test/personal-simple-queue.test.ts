import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { launchQueueWorker } from "../src/personal/queue-background.js";
import { PersonalMvpController } from "../src/personal/controller.js";
import { JsonRunStateStore } from "../src/personal/json-run-state.js";
import { TEST_MATERIAL } from "./helpers/personal-launch.js";
import { rm, writeFile } from "node:fs/promises";
import { windowsLaunch } from "../src/personal/windows-launch.js";
import path from "node:path";
import test from "node:test";
import { launchTestRoot } from "./helpers/windows-launch.js";
import { SimpleQueueStore, runSimpleQueue, queueDigest, validateSimpleSeal, readSimpleSeal, writeSimpleSeal, type SimpleQueueSeal } from "../src/personal/simple-queue.js";
import { captureLaunchMaterial } from "../src/personal/launch-material.js";
import { validateQueueAttestation } from "../src/personal/queue-attestation.js";
import type { OwnerPiIdentity } from "../src/personal/runtime-parity.js";
import { parseSimpleQueueArgs, checkContract } from "../src/personal/simple-queue-cli.js";
import type { PersonalRunState } from "../src/personal/types.js";

function fakeSeal(id: string, tickets: string[]): SimpleQueueSeal {
  return { queueId: id, attestation: { approved: tickets.map(ticketId => ({ ticketId, contractSha256: "a".repeat(64) })) } } as unknown as SimpleQueueSeal;
}
function published(ticketId: string, runId: string): PersonalRunState {
  return { ticketId, runId, status: "completed", publicationState: "published", prUrl: `https://github.com/acme/repo/pull/${runId}` } as PersonalRunState;
}
async function fixture(run: (store: SimpleQueueStore, id: string) => Promise<void>): Promise<void> {
  const parent = await launchTestRoot("squire-queue-simple-");
  const id = randomUUID();
  try { await run(new SimpleQueueStore(path.join(parent, id)), id); }
  finally {
    // A detached Windows worker can still hold its root momentarily after
    // persisting terminal state; do not interpret that as a queue failure.
    for (let attempt = 0; ; attempt++) {
      try { await rm(parent, { recursive: true, force: true }); break; }
      catch (error) {
        if (process.platform !== "win32" || attempt === 19 || !["EBUSY", "EPERM", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
  }
}
test("queue dispatches in exact order, records run IDs and PRs, with no merge or source advancement", async () => fixture(async (store, id) => {
  const order: string[] = [];
  const state = await runSimpleQueue({ store, seal: fakeSeal(id, ["AIDEV-1", "AIDEV-2"]), async run(ticket, _digest, _signal, onReserved) {
    order.push(ticket);
    await onReserved(`run-${order.length}`);
    assert.equal((await store.read()).runId, `run-${order.length}`);
    return published(ticket, String(order.length));
  } });
  assert.deepEqual(order, ["AIDEV-1", "AIDEV-2"]);
  assert.equal(state.status, "completed");
  assert.deepEqual(state.prs, ["https://github.com/acme/repo/pull/1", "https://github.com/acme/repo/pull/2"]);
  assert.equal((await store.read()).index, 2);
}));
test("failure stops before the next ticket, preserves previous PR and terminal state", async () => fixture(async (store, id) => {
  const order: string[] = [];
  const state = await runSimpleQueue({ store, seal: fakeSeal(id, ["AIDEV-1", "AIDEV-2", "AIDEV-3"]), async run(ticket, _digest, _signal, onReserved) {
    order.push(ticket); await onReserved(`run-${order.length}`);
    if (ticket === "AIDEV-2") throw Error("candidate failed");
    return published(ticket, "1");
  } });
  assert.deepEqual(order, ["AIDEV-1", "AIDEV-2"]);
  assert.equal(state.status, "blocked"); assert.equal(state.runId, "run-2"); assert.equal(state.index, 1);
  assert.deepEqual(state.prs, ["https://github.com/acme/repo/pull/1"]);
  assert.match(state.error ?? "", /candidate failed/);
}));
test("interrupted active run blocks without dispatching another ticket", async () => fixture(async (store, id) => {
  const order: string[] = [];
  const state = await runSimpleQueue({ store, seal: fakeSeal(id, ["AIDEV-1", "AIDEV-2"]), async run(ticket, _digest, _signal, onReserved) {
    order.push(ticket); await onReserved("run-1"); await store.cancel();
    assert.equal(await store.cancelled(), true);
    throw Error("active run stopped without publication");
  } });
  assert.deepEqual(order, ["AIDEV-1"]); assert.equal(state.status, "blocked");
}));
test("cancellation racing a published PR retains the PR and stops the next ticket", async () => fixture(async (store, id) => {
  const order: string[] = [];
  const result = await runSimpleQueue({ store, seal: fakeSeal(id, ["AIDEV-1", "AIDEV-2"]), async run(ticket, _digest, _signal, onReserved) {
    order.push(ticket); await onReserved("run-1"); await store.cancel(); return published(ticket, "1");
  } });
  assert.deepEqual(order, ["AIDEV-1"]); assert.equal(result.status, "cancelled"); assert.equal(result.index, 1);
  assert.deepEqual(result.prs, ["https://github.com/acme/repo/pull/1"]);
}));
test("cancellation racing a failed publication is blocked, not claimed cancelled", async () => fixture(async (store, id) => {
  const result = await runSimpleQueue({ store, seal: fakeSeal(id, ["AIDEV-1", "AIDEV-2"]), async run(_ticket, _digest, _signal, onReserved) {
    await onReserved("run-1"); await store.cancel(); throw Error("publication uncertain");
  } });
  assert.equal(result.status, "blocked"); assert.equal(result.runId, "run-1");
  assert.match(result.error ?? "", /publication uncertain/);
}));
test("foreign cancellation marker blocks dispatch instead of being ignored", async () => fixture(async (store, id) => {
  const result = await runSimpleQueue({ store, seal: fakeSeal(id, ["AIDEV-1", "AIDEV-2"]), async run(ticket, _digest, _signal, onReserved) {
    await onReserved("run-1");
    const marker = path.join(store.root, "cancel.json");
    const bytes = Buffer.from(JSON.stringify({ queueId: randomUUID(), nonce: randomUUID() }));
    if (process.platform === "win32") { const h = windowsLaunch().openReport(marker, bytes); windowsLaunch().closeReport(h.lease); }
    else await writeFile(marker, bytes, { flag: "wx", mode: 0o600 });
    return published(ticket, "1");
  } });
  assert.equal(result.status, "blocked"); assert.equal(result.index, 1);
  assert.deepEqual(result.prs, ["https://github.com/acme/repo/pull/1"]);
  assert.match(result.error ?? "", /cancellation marker identity invalid/);
}));
test("ambiguous leftover owner claim cannot be restarted or overwrite initial state", async () => fixture(async (store, id) => {
  const seal = fakeSeal(id, ["AIDEV-1"]);
  await runSimpleQueue({ store, seal, async run(ticket) { return published(ticket, "1"); } });
  await assert.rejects(runSimpleQueue({ store, seal, async run(ticket) { return published(ticket, "2"); } }));
  assert.equal((await store.read()).prs[0], "https://github.com/acme/repo/pull/1");
}));
test("detached worker survives launcher, publishes both PRs in order and persists terminal status", async () => fixture(async (store, id) => {
  const fixturePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../fixtures/simple-queue-worker.mjs");
  const root = store.root;
  await launchQueueWorker({ executable: process.execPath, cliPath: fixturePath, queueId: id, configPath: path.join(root, "config.json"), root,
    ref: { path: path.join(root, "seal", `${randomUUID()}.json`), sha256: "a".repeat(64), byteLength: 1, identity: "1:2" } });
  let state = await store.read();
  for (let i = 0; i < 50 && state.status !== "completed"; i++) {
    await new Promise(resolve => setTimeout(resolve, 30));
    state = await store.read();
  }
  assert.equal(state.status, "completed");
  assert.deepEqual(state.prs, ["https://github.com/acme/repo/pull/1", "https://github.com/acme/repo/pull/2"]);
}));
test("production worker claims and blocks a preflight failure before dispatch", async () => fixture(async (store, id) => {
  await store.write({ version: 1, queueId: id, tickets: ["AIDEV-1"], index: 0, status: "queued", runId: null, prs: [], error: null }, true);
  const cliPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/personal/cli.js");
  await assert.rejects(launchQueueWorker({ executable: process.execPath, cliPath, queueId: id,
    configPath: path.join(store.root, "missing-config.json"), root: store.root,
    ref: { path: path.join(store.root, "seal", `${randomUUID()}.json`), sha256: "a".repeat(64), byteLength: 1, identity: "1:2" },
  }), /acknowledgement|exited/);
  const state = await store.read();
  assert.equal(state.status, "blocked"); assert.equal(state.index, 0); assert.equal(state.prs.length, 0);
  await assert.rejects(store.claim(), /EEXIST|already exists|exists|Win32 183/i);
}));
test("Linear preflight forwards queue cancellation signal", async () => {
  const abort = new AbortController(); let passed: AbortSignal | undefined;
  const result = checkContract({ async get(_id, signal) {
    passed = signal;
    return new Promise((_resolve, reject) => { signal?.addEventListener("abort", () => reject(signal.reason), { once: true }); });
  } }, "AIDEV-1", "a".repeat(64), abort.signal);
  abort.abort(Error("cancel preflight"));
  await assert.rejects(result, /cancel preflight/);
  assert.equal(passed, abort.signal);
});
test("private seal read binds exact owner approval, config and source SHA", async () => fixture(async (store, id) => {
  const snapshot = Buffer.from('{"providers":{}}');
  const identity: OwnerPiIdentity = {
    schema: 1, pid: process.pid, cliPath: process.execPath, version: "0.87.0", manifestSha256: "a".repeat(64), cliSha256: "b".repeat(64), codeTreeSha256: "d".repeat(64), modelConfigPath: path.resolve("models.json"), modelConfigSha256: null, phaseModelsSha256: "e".repeat(64), modelStorePath: path.resolve("models-store.json"), modelStoreSha256: createHash("sha256").update(snapshot).digest("hex"), modelStoreSnapshotBase64: snapshot.toString("base64"), models: ["openai-codex/gpt-6-luna", "openai-codex/gpt-6-sol"], extensions: [],
  };
  const sha = "f".repeat(40), contract = { id: "AIDEV-1", title: "Approved", description: "exact" };
  const digest = createHash("sha256").update(JSON.stringify(contract)).digest("hex");
  const raw = JSON.parse(Buffer.from(TEST_MATERIAL.rawConfig, "base64").toString("utf8")); raw.repository.sourceRef = sha;
  const bytes = Buffer.from(JSON.stringify(raw));
  const material = await captureLaunchMaterial({ rawConfig: bytes.toString("base64"), digest: createHash("sha256").update(bytes).digest("hex"), config: { ...TEST_MATERIAL.config, repository: { ...TEST_MATERIAL.config.repository, sourceRef: sha } } }, identity);
  const approved = [{ ticketId: "AIDEV-1", contractSha256: digest, contract }];
  const attestation = validateQueueAttestation({ schema: 1, ownerPid: process.pid, manifestSha256: queueDigest(["AIDEV-1"], "a".repeat(64), sha), queueId: id, nonce: randomUUID(), approved }, queueDigest(["AIDEV-1"], "a".repeat(64), sha), identity, ["AIDEV-1"]);
  const seal = validateSimpleSeal({ version: 1, queueId: id, configPath: path.resolve("squire.json"), configSha256: "a".repeat(64), material, attestation });
  const ref = await writeSimpleSeal(store.root, seal);
  assert.equal((await readSimpleSeal(store.root, ref)).queueId, id);
  assert.throws(() => validateSimpleSeal({ ...seal, configSha256: "b".repeat(64) }), /attestation identity mismatch/);
  assert.throws(() => validateQueueAttestation({ ...attestation, approved: [{ ...approved[0], contract: { ...contract, title: "altered" } }] }, attestation.manifestSha256, identity, ["AIDEV-1"]), /contract bytes\/digest mismatch/);
  await assert.rejects(readSimpleSeal(store.root, { ...ref, sha256: "0".repeat(64) }), /digest|mismatch|hash/i);
}));
test("controller rejects changed approved Linear contract before preparing a workspace", async () => {
  const parent = await launchTestRoot("squire-queue-contract-");
  try {
    let prepared = false;
    const states = new JsonRunStateStore(parent);
    const controller = new PersonalMvpController({
      launchMaterial: TEST_MATERIAL, states, expectedContractSha256: "a".repeat(64),
      tickets: { async get(id) { return { id, title: "changed", description: "not approved" }; } },
      workspaces: { async prepare() { prepared = true; throw Error("workspace should not be prepared"); } } as never,
      phases: {} as never, publication: {} as never,
    });
    const request = { ticketId: "AIDEV-1", repository: "example/repo", repositoryPath: "/tmp/example-repo", sourceRef: "HEAD", baseBranch: "main" };
    await assert.rejects(controller.run(request), /queue approved Linear contract changed/);
    assert.equal(prepared, false);
    const runs = await states.findByTicket("AIDEV-1");
    assert.equal(runs.length, 1); assert.equal(runs[0]?.status, "failed");
  } finally { await rm(parent, { recursive: true, force: true }); }
});
test("CLI and digest require explicit ordered unique tickets", () => {
  const config = path.resolve("config.json");
  assert.deepEqual(parseSimpleQueueArgs(["queue", "start", "AIDEV-1", "AIDEV-2", "--config", config])?.tickets, ["AIDEV-1", "AIDEV-2"]);
  assert.equal(parseSimpleQueueArgs(["queue", "start", "AIDEV-1", "AIDEV-1", "--config", config]), undefined);
  const root = path.resolve("queues", randomUUID());
  assert.equal(parseSimpleQueueArgs(["queue", "status", path.basename(root), "--root", root])?.root, root);
  assert.equal(parseSimpleQueueArgs(["queue", "cancel", path.basename(root), "--root", root]), undefined);
  assert.notEqual(queueDigest(["AIDEV-1", "AIDEV-2"], "a".repeat(64), "b".repeat(40)), queueDigest(["AIDEV-2", "AIDEV-1"], "a".repeat(64), "b".repeat(40)));
});
