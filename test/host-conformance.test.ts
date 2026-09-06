import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildHostConformanceEvidence, buildHostObserverRequest, hostConformanceEvidenceDigest, validateHostConformanceEvidence, validateHostObserverRequest, validateHostObserverResult } from "../src/sandbox/host-conformance.js";
import { buildHostProbeRequest } from "../src/sandbox/host-acceptance.js";
import { canonicalBytes, canonicalJson, deriveSandboxName, sha256Bytes } from "../src/sandbox/identity.js";

test("host observer request/result/evidence stay request-bound and canonical", () => {
  const runId = "run_hostconformance01";
  const parent = buildHostProbeRequest({ runId, sandboxName: deriveSandboxName(runId), releaseId: "release-v039", platform: "linux", architecture: "amd64", probes: ["network-audit"], requestedAt: "2026-09-01T12:00:00.000Z" });
  const request = buildHostObserverRequest({ parentRequestId: parent.requestId, runId, sandboxName: parent.sandboxName, releaseId: parent.releaseId, platform: parent.platform, architecture: parent.architecture, probe: "network-audit", phase: "running", identity: { sandboxId: "sandbox-1", vmId: "vm-1", bootId: "boot-1", templateDigest: "sha256:" + "a".repeat(64) }, paths: { stateRoot: "/tmp/host-state", bridgePath: "/tmp/host-state/bridge", evidenceRoot: "/tmp/evidence" }, requestedAt: parent.requestedAt });
  assert.deepEqual(validateHostObserverRequest(request), request);
  const result = { schemaVersion: 1 as const, kind: "squire-sandbox-host-observer-result" as const, requestId: request.requestId, parentRequestId: request.parentRequestId, runId, sandboxName: request.sandboxName, releaseId: request.releaseId, platform: request.platform, architecture: request.architecture, probe: request.probe, phase: request.phase, identity: request.identity, status: "pass" as const, hostOnly: true as const, observations: { allowedHttpsObserved: true, deniedProbeObserved: true, attributionVerified: true, authentication: "trusted-host", verified: true }, completedAt: "2026-09-01T12:00:01.000Z" };
  assert.deepEqual(validateHostObserverResult(result, request), result);
  const evidence = buildHostConformanceEvidence(result, "2026-09-01T12:00:02.000Z");
  assert.deepEqual(validateHostConformanceEvidence(evidence), evidence);
  assert.match(hostConformanceEvidenceDigest(evidence), /^[0-9a-f]{64}$/);
  assert.throws(() => validateHostObserverResult({ ...result, runId: "run_other" }, request), /identity/);
  assert.throws(() => validateHostConformanceEvidence({ ...evidence, observations: { ...evidence.observations, forged: "not-bounded-proof" }, status: "fail" }), /passing/);
});

function runNode(script: string, args: readonly string[]): Promise<{ readonly code: number | null; readonly stdout: string; readonly stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { cwd: path.resolve("."), env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin", LANG: "C.UTF-8", LC_ALL: "C.UTF-8" }, stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = []; const stderr: Buffer[] = [];
    child.stdout.on("data", chunk => stdout.push(Buffer.from(chunk))); child.stderr.on("data", chunk => stderr.push(Buffer.from(chunk)));
    child.once("error", reject); child.once("exit", (code, signal) => resolve({ code: code ?? (signal ? 1 : null), stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") }));
  });
}

function writeCanonical(file: string, value: unknown): Promise<void> { return writeFile(file, canonicalBytes(value), { mode: 0o600 }); }

test("build input resolves an immutable base and the observer adapter authenticates raw host evidence", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "squire-host-harness-"));
  try {
    const context = path.join(root, "context"); const buildManifest = path.join(root, "template-build.json");
    const build = await runNode("scripts/build-sandbox-template.mjs", ["--base-image", "registry.example/project/base", "--base-digest", `sha256:${"a".repeat(64)}`, "--output", buildManifest, "--context", context]);
    assert.equal(build.code, 0, build.stderr); const buildValue = JSON.parse(await readFile(buildManifest, "utf8"));
    assert.equal(buildValue.runtimeBundle.sha256, buildValue.helperDigests.at(-1)); assert.match(await readFile(path.join(context, "Dockerfile"), "utf8"), new RegExp(`FROM registry\\.example/project/base@sha256:${"a".repeat(64)}`));

    const inputRoot = path.join(root, "observer-input"); await mkdir(inputRoot, { mode: 0o700 });
    const runId = "run_hostharness01"; const templateDigest = `sha256:${"b".repeat(64)}`; const policy = { allowedHosts: [], mode: "deny-all" }; const networkProfileDigest = sha256Bytes(Buffer.from(canonicalJson(policy), "utf8"));
    const parent = buildHostProbeRequest({ runId, sandboxName: deriveSandboxName(runId), releaseId: "release-v039", platform: "linux", architecture: "amd64", probes: ["network-audit"], requestedAt: "2026-09-01T12:00:00.000Z" });
    const request = buildHostObserverRequest({ parentRequestId: parent.requestId, runId, sandboxName: parent.sandboxName, releaseId: parent.releaseId, platform: parent.platform, architecture: parent.architecture, probe: "network-audit", phase: "running", identity: { sandboxId: "sandbox-host", vmId: "vm-host", bootId: "boot-host", templateDigest }, paths: { stateRoot: path.join(root, "state"), bridgePath: path.join(root, "bridge"), evidenceRoot: path.join(root, "evidence") }, requestedAt: parent.requestedAt });
    const requestFile = path.join(root, "observer-request.json"); const outputFile = path.join(root, "observer-result.json"); const releaseFile = path.join(root, "release-context.json"); const tupleFile = path.join(root, "tuple-context.json"); const policyFile = path.join(root, "network-policy.json");
    await writeCanonical(requestFile, request); await writeCanonical(releaseFile, { releaseId: request.releaseId, template: { digest: templateDigest } }); await writeCanonical(tupleFile, { releaseId: request.releaseId, templateDigest, networkProfileDigest, bridgeQuotaBytes: 65_536, resourceTuple: { tupleId: "small" } }); await writeCanonical(policyFile, policy);
    const rawFile = path.join(inputRoot, "raw-proof.json"); const raw = Buffer.from("trusted host observation\n", "utf8"); await writeFile(rawFile, raw, { mode: 0o600 });
    const packet = { schemaVersion: 1, kind: "squire-sandbox-host-observer-input", requestId: request.requestId, parentRequestId: request.parentRequestId, runId, sandboxName: request.sandboxName, releaseId: request.releaseId, platform: request.platform, architecture: request.architecture, probe: request.probe, phase: request.phase, identity: request.identity, context: { releaseId: request.releaseId, templateDigest, networkProfileDigest, resourceTupleId: "small", bridgeQuotaBytes: 65_536 }, observations: { verified: true, authentication: "trusted-host", allowedHttpsObserved: true, deniedProbeObserved: true, attributionVerified: true }, evidence: { path: "raw-proof.json", sha256: sha256Bytes(raw) }, completedAt: "2026-09-01T12:00:01.000Z" };
    await writeCanonical(path.join(inputRoot, "network-audit.json"), packet);
    const observerScript = "scripts/acceptance/sandbox-host-observer.mjs"; const result = await runNode(observerScript, ["--request", requestFile, "--output", outputFile, "--input-root", inputRoot, "--release", releaseFile, "--resource-tuple", tupleFile, "--network-policy", policyFile]); assert.equal(result.code, 0, result.stderr); const observed = JSON.parse(await readFile(outputFile, "utf8")); assert.equal(validateHostObserverResult(observed, request).observations["externalEvidenceSha256"], sha256Bytes(raw));
    await writeCanonical(path.join(inputRoot, "network-audit.json"), { ...packet, evidence: { path: "raw-proof.json", sha256: "0".repeat(64) } }); const rejected = await runNode(observerScript, ["--request", requestFile, "--output", path.join(root, "rejected.json"), "--input-root", inputRoot, "--release", releaseFile, "--resource-tuple", tupleFile, "--network-policy", policyFile]); assert.notEqual(rejected.code, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});
