import assert from "node:assert/strict";
import { access, chmod, mkdir, open, readFile, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { JsonRunStateStore } from "../src/personal/json-run-state.js";
import { evidencePath, publishOwner } from "../src/personal/reservation-observation.js";
import { findRunState, StatusLookupError } from "../src/personal/status.js";
import { windowsLaunch } from "../src/personal/windows-launch.js";
import { launchTestRoot } from "./helpers/windows-launch.js";
import { statusOwnerState } from "./helpers/status-owner-state.js";
import { readOnlyTree } from "./helpers/status-read-only-tree.js";

const state = statusOwnerState();
const lockPath = (root: string) => path.join(root, "locks", "aidev-305.lock");
async function replace(file: string, raw?: string) {
  const temporary = `${file}.replacement`;
  await writeFile(temporary, raw ?? await readFile(file, "utf8"), { flag: "wx" });
  if (process.platform === "win32") windowsLaunch().replaceState(temporary, file);
  else await rename(temporary, file);
}
async function rejectBoth(store: JsonRunStateStore) {
  for (const selector of [state.runId, state.ticketId]) {
    await assert.rejects(findRunState(store, selector), error => error instanceof StatusLookupError && error.code === "ambiguous" && !/[\r\n\u001b]/u.test(error.message));
  }
}

test("status only observes; no mutation query, state writes, or missing-directory creation", async () => {
  const root = await launchTestRoot("squire-read-only-status-");
  try {
    const missing = path.join(root, "missing");
    const absent = new JsonRunStateStore(missing);
    assert.deepEqual(await absent.list(), []);
    assert.deepEqual(await absent.observeReservation(state.ticketId), { kind: "absent" });
    await assert.rejects(findRunState(absent, state.ticketId), error => error instanceof StatusLookupError && error.code === "missing");
    await assert.rejects(access(missing));
    const store = new JsonRunStateStore(root);
    await store.reserve(state);
    store.reservationOwner = async () => { throw new Error("mutation mutex query called"); };
    store.reserve = store.save = store.release = async () => { throw new Error("mutation called"); };
    const before = await readOnlyTree(root);
    assert.equal((await store.observeReservation(state.ticketId)).kind, "owner");
    assert.deepEqual(await findRunState(store, state.runId), state);
    assert.deepEqual(await findRunState(store, state.ticketId), state);
    assert.deepEqual(await readOnlyTree(root), before);
  } finally { await rm(root, { recursive: true, force: true }); }
});

const mutations: Record<string, (root: string, store: JsonRunStateStore) => Promise<unknown>> = {
  "empty reservation": root => writeFile(lockPath(root), ""),
  "malformed reservation": root => writeFile(lockPath(root), "bad\n\u001b[2Jsecret"),
  "mismatched reservation run": root => writeFile(lockPath(root), "aidev-305-other12345\n"),
  "missing reservation": root => unlink(lockPath(root)),
  "missing owner evidence": root => unlink(evidencePath(root, state.ticketId)),
  "malformed owner evidence": root => writeFile(evidencePath(root, state.ticketId), "{bad\u001b[2J"),
  "empty owner evidence": root => writeFile(evidencePath(root, state.ticketId), ""),
  "duplicate owner fields": async root => {
    const file = evidencePath(root, state.ticketId);
    await writeFile(file, (await readFile(file, "utf8")).replace('"pid":', '"pid":123,"pid":'));
  },
  "same-content replaced reservation": root => replace(lockPath(root)),
  "same-content replaced owner evidence": root => replace(evidencePath(root, state.ticketId)),
  "unreadable nonregular evidence": async root => { await unlink(evidencePath(root, state.ticketId)); await mkdir(evidencePath(root, state.ticketId)); },
  "empty operation marker": async root => { await writeFile(path.join(root, "ticket-operations", "aidev-305.lock"), ""); },
  "legacy operation marker": root => writeFile(path.join(root, "ticket-operations", "aidev-305.lock"), `${process.pid}-legacy\n`),
  "multiple running states including exact selector": (root, store) => store.create({ ...state, runId: "aidev-305-second12345", sandbox: "squire-aidev-305-second12345" }),
  "terminal state retaining own reservation": (root, store) => store.save({ ...state, version: 2, status: "failed", endedAt: state.updatedAt, lastError: "fixture" }),
};
for (const [field, value] of [
  ["ticketId", "AIDEV-999"], ["runId", "aidev-305-mismatch123"], ["process", "0:1"],
  ["pid", 4294967295], ["reservation", "0:1"], ["identity", "0:1"], ["fence", "invalid"], ["role", "reserver"],
] as const) {
  mutations[`contradictory owner ${field} (PID reuse for process)`] = async root => {
    const file = evidencePath(root, state.ticketId);
    const record = JSON.parse(await readFile(file, "utf8"));
    record[field] = value;
    await writeFile(file, JSON.stringify(record));
  };
}
for (const [label, mutate] of Object.entries(mutations)) {
  test(`observation rejects ${label} without mutation`, async () => {
    const root = await launchTestRoot("squire-status-negative-");
    try {
      const store = new JsonRunStateStore(root);
      await store.reserve(state);
      await mutate(root, store);
      const before = await readOnlyTree(root);
      await rejectBoth(store);
      assert.deepEqual(await readOnlyTree(root), before);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}

for (const target of ["reservation", "owner", "operation"] as const) {
  for (const action of ["replace", "remove"] as const) {
    test(`pinned observation rejects ${action} of ${target} during its consistency check`, async () => {
      const root = await launchTestRoot("squire-status-race-");
      try {
        const store = new JsonRunStateStore(root);
        await store.reserve(state);
        const file = target === "reservation" ? lockPath(root) : target === "owner" ? evidencePath(root, state.ticketId) : path.join(root, "ticket-operations", "aidev-305.lock");
        if (target === "operation") {
          // Retain a legitimate operation through the existing release barrier
          // is covered multiprocess. Here construct the exact marker schema
          // against this process to isolate pathname replacement deterministically.
          const { currentProcessIdentity, fileIdentity } = await import("../src/personal/reservation-observation.js");
          const handle = await open(file, "wx");
          try {
            await handle.writeFile(JSON.stringify({ version: 1, ticketId: state.ticketId, pid: process.pid,
              token: "12345678-1234-1234-1234-123456789abc", process: await currentProcessIdentity(), identity: await fileIdentity(handle),
              owner: JSON.parse(await readFile(evidencePath(root, state.ticketId), "utf8")) }));
          } finally { await handle.close(); }
          assert.equal((await store.observeReservation(state.ticketId)).kind, "owner");
        }
        let changed = false;
        const observer = new JsonRunStateStore(root, { observation: { afterSnapshot: async () => {
          if (changed) return;
          if (action === "replace") await replace(file); else await unlink(file);
          changed = true;
        } } });
        assert.equal((await observer.observeReservation(state.ticketId)).kind, "ambiguous");
        assert.equal(changed, true);
        const before = await readOnlyTree(root);
        if (target === "operation" && action === "remove") {
          // The raced observation rejects, but a fresh stable snapshot after
          // normal operation release is valid.
          assert.deepEqual(await findRunState(store, state.runId), state);
        } else {
          await rejectBoth(store);
        }
        assert.deepEqual(await readOnlyTree(root), before);
      } finally { await rm(root, { recursive: true, force: true }); }
    });
  }
}

test("observation brackets state selection and rejects a fresh owner generation", async () => {
  const root = await launchTestRoot("squire-status-generation-");
  try {
    const store = new JsonRunStateStore(root);
    await store.reserve(state);
    const find = store.findByTicket.bind(store);
    store.findByTicket = async ticket => {
      const result = await find(ticket);
      await publishOwner(root, state.ticketId, state.runId, lockPath(root), "controller");
      return result;
    };
    await rejectBoth(store);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("reparse/symlink evidence and permission-denied reads fail closed", { skip: process.platform === "win32" }, async () => {
  const root = await launchTestRoot("squire-status-unreadable-");
  const store = new JsonRunStateStore(root);
  const file = evidencePath(root, state.ticketId);
  try {
    await store.reserve(state);
    await chmod(file, 0);
    await rejectBoth(store);
    await chmod(file, 0o600);
    await rename(file, `${file}.real`);
    await symlink(`${file}.real`, file);
    await rejectBoth(store);
  } finally { await rm(root, { recursive: true, force: true }); }
});


test("junction ancestors are not owner evidence", { skip: process.platform !== "win32" }, async () => {
  const root = await launchTestRoot("squire-status-junction-");
  try {
    const store = new JsonRunStateStore(root);
    await store.reserve(state);
    const directory = path.dirname(evidencePath(root, state.ticketId));
    await rename(directory, `${directory}-real`);
    await symlink(`${directory}-real`, directory, "junction");
    await rejectBoth(store);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("orphan evidence remains ambiguous without state and historical selection remains deterministic", async () => {
  const root = await launchTestRoot("squire-status-history-");
  try {
    const store = new JsonRunStateStore(root);
    await store.reserve(state);
    await unlink(path.join(root, `${state.runId}.json`));
    await assert.rejects(findRunState(store, state.ticketId), e => e instanceof StatusLookupError && e.code === "ambiguous");
    await store.create({ ...state, status: "failed", endedAt: state.updatedAt, lastError: "fixture" });
    await store.release(state.ticketId, state.runId);
    const newest = { ...state, runId: "aidev-305-history12345", sandbox: "squire-aidev-305-history12345", status: "failed" as const,
      endedAt: state.updatedAt, lastError: "fixture", updatedAt: "2026-09-20T00:00:01.000Z" };
    await store.create(newest);
    assert.deepEqual(await findRunState(store, state.ticketId), newest);
    assert.equal((await findRunState(store, state.runId)).runId, state.runId);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a valid but mismatched fence cannot impersonate the retained operation owner", async () => {
  const root = await launchTestRoot("squire-status-fence-");
  try {
    const store = new JsonRunStateStore(root);
    await store.reserve(state);
    const { currentProcessIdentity, fileIdentity } = await import("../src/personal/reservation-observation.js");
    const ownerPath = evidencePath(root, state.ticketId);
    const owner = JSON.parse(await readFile(ownerPath, "utf8"));
    const operation = await open(path.join(root, "ticket-operations", "aidev-305.lock"), "wx");
    try {
      await operation.writeFile(JSON.stringify({ version: 1, ticketId: state.ticketId, pid: process.pid,
        token: "12345678-1234-1234-1234-123456789abc", process: await currentProcessIdentity(), identity: await fileIdentity(operation), owner }));
      assert.equal((await store.observeReservation(state.ticketId)).kind, "owner");
      await writeFile(ownerPath, JSON.stringify({ ...owner, fence: "12345678-1234-1234-1234-123456789abc" }));
      const before = await readOnlyTree(root);
      await rejectBoth(store);
      assert.deepEqual(await readOnlyTree(root), before);
    } finally { await operation.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});
