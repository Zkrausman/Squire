import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { run, runtime } from "./support/fixtures.js";
import { InMemoryWorkflowStore } from "./support/in-memory-workflow-store.js";
import { FakeSbxDriver, fakeSandboxRelease } from "./support/fake-sbx-driver.js";
import { BridgeManager, RecordingBridgeQuotaAdministrator } from "../src/sandbox/bridge-manager.js";
import { SandboxContractValidator, assertAttestationSemantics, assertSpecSemantics } from "../src/sandbox/contracts.js";
import { MeasuredSandboxAttestor, type SandboxAttestorPort, type MeasuredSandboxEvidence } from "../src/sandbox/attestation.js";
import { SandboxLifecycleService } from "../src/sandbox/lifecycle-service.js";
import { SandboxRecoveryService } from "../src/sandbox/recovery.js";
import { SandboxTransferService } from "../src/sandbox/transfer-service.js";
import { GuestFrameDecoder, GuestOperationClient, encodeGuestFrame, makeGuestRequest, parseGuestMessage, type GuestBinding, type GuestOperationResponse } from "../src/sandbox/guest-protocol.js";
import { GuestIsolationCanarySuite, IsolationProbeError, assertMountIsolation, parseMountInfo } from "../src/sandbox/isolation-probes.js";
import { HostProcessSupervisor, InMemoryHostProcessLedger } from "../src/sandbox/host-process-supervisor.js";
import { SbxCommandError, SbxV039CommandBuilder, parseSbxListOutput, parseSbxVersionOutput } from "../src/sandbox/sbx-command.js";
import { SandboxResourceVerifier, ResourceVerificationError } from "../src/sandbox/resource-verifier.js";
import { SandboxReleaseResolver } from "../src/sandbox/release-resolver.js";
import { buildSandboxSpec, canonicalBytes, canonicalJson, deriveBridgeName, deriveSandboxName, sha256Bytes } from "../src/sandbox/identity.js";
import type { SandboxAttestationDocument, SandboxReleaseManifestDocument, SandboxSpecDocument } from "../src/sandbox/domain.js";

const templateDigest = "sha256:" + "a".repeat(64);
const networkProfileDigest = "eaf2d7d4d6f5159b028304905892bb7c0ac15b8e35219cb6dd3e2d9a140d52a3";
const proof = { path: "evidence/sandbox/resource.json", sha256: "b".repeat(64), schemaId: "urn:squire:sandbox:v1:resource" };
const resources = { cpus: 2, memoryMiB: 512, disk: { enforcement: "quota-composed" as const, ticketQuotaBytes: 1_048_576, bridgeQuotaBytes: 65_536, writableTmpfsBytes: 65_536, proof } };
const network = { mode: "deny-all" as const, allowedHosts: [], profileDigest: networkProfileDigest };
const networkObservation = { path: "evidence/sandbox/network.json", sha256: "3".repeat(64), schemaId: "urn:squire:sandbox:v1:host-evidence" } as const;
const networkAudit = { request: { runId: "run_example01", sandboxName: deriveSandboxName("run_example01"), sandboxId: "sandbox-1", correlationId: "corr-123456", profileDigest: networkProfileDigest, mode: "deny-all" as const, allowedHosts: [] }, allowedHttps: { correlationId: "corr-123456", succeeded: true, attributedSandbox: deriveSandboxName("run_example01") }, denied: [{ target: "169.254.169.254", protocol: "tcp" as const, denied: true, attributedSandbox: deriveSandboxName("run_example01") }, { target: "192.0.2.1", protocol: "udp" as const, denied: true, attributedSandbox: deriveSandboxName("run_example01") }, { target: "198.51.100.1", protocol: "icmp" as const, denied: true, attributedSandbox: deriveSandboxName("run_example01") }], hostObservation: networkObservation, hostOnly: true as const };
const retention = { successUntil: "2026-10-01T00:00:00.000Z", failureUntil: "2026-10-02T00:00:00.000Z", artifactUntil: "2026-10-03T00:00:00.000Z" };

function spec(): SandboxSpecDocument { return buildSandboxSpec({ runId: "run_example01", ticketIdentifier: "AIDEV-223", template: { name: "registry/sandbox", digest: templateDigest }, resources, network, bridgeQuotaBytes: 65_536, retention, creationNonce: "11111111-1111-4111-8111-111111111111" }); }
function binding(): GuestBinding { return { runId: "run_example01", sandboxName: deriveSandboxName("run_example01"), sandboxId: "sandbox-1", bootId: "boot-1", operationGeneration: 1, releaseId: "fixture-release", helperDigest: "f".repeat(64) }; }
function raw(value: unknown): Buffer { return Buffer.from(JSON.stringify(value), "utf8"); }
function observeFixtureBinary(release: SandboxReleaseManifestDocument) { return { path: release.sbxBinary.path, versionOutput: release.sbxBinary.versionOutput, sha256: release.sbxBinary.sha256, helpDigest: release.sbxBinary.helpDigest }; }

class FakeOutput extends EventEmitter { readonly frames: Buffer[] = []; write(frame: Uint8Array): boolean { this.frames.push(Buffer.from(frame)); return true; } }
class FakeWorkerOutput extends EventEmitter { write(_frame: Uint8Array): boolean { return true; } }
class FakeWorker extends EventEmitter {
  readonly stdin = { write: (frame: Uint8Array): boolean => { const message = parseGuestMessage(frame.subarray(4)); if (message.kind !== "squire-guest-operation-request") throw new Error("fake worker received a response"); const payload = message.payload; const data = message.operation === "import" ? { bridgeUsed: false, byteLength: payload["byteLength"], path: payload["publishPath"], sha256: payload["sha256"], transferGeneration: payload["transferGeneration"] } : message.operation === "export" ? { bridgeUsed: false, byteLength: payload["byteLength"], path: payload["path"], sha256: payload["sha256"], transferGeneration: payload["transferGeneration"] } : { ok: true }; const response: GuestOperationResponse = { schemaVersion: 1, kind: "squire-guest-operation-response", requestId: message.requestId, binding: message.binding, operation: message.operation, success: true, data }; queueMicrotask(() => this.stdout.emit("data", encodeGuestFrame(response))); return true; } };
  readonly stdout = new FakeOutput();
  readonly stderr = new FakeOutput();
  readonly identity = "host-child:1:start:" + "a".repeat(64);
  readonly pid = 1; readonly startTime = "start"; readonly executable = "/ticket/runtime/sbx"; readonly executableDigest = "a".repeat(64); readonly exitCode: number | null = null; readonly exitSignal: string | null = null;
  kill(): boolean { return true; }
  waitForExit(): Promise<void> { return Promise.resolve(); }
}

class TestClock { #now = Date.parse("2026-09-01T12:00:00.000Z"); now(): number { return this.#now; } async sleep(ms: number): Promise<void> { this.#now += ms; } }

void FakeWorkerOutput;
void raw;
void randomBytes;

test("sandbox identities, canonical contracts, and semantic bindings are closed", async () => {
  const value = spec();
  assert.equal(value.sandboxName, deriveSandboxName(value.runId));
  assert.equal(value.bridge.name, deriveBridgeName(value.runId));
  assertSpecSemantics(value);
  const validator = await SandboxContractValidator.create(path.resolve("contracts/sandbox/v1"));
  assert.deepEqual(validator.validateSpec(validator.validateBytes("urn:squire:sandbox:v1:sandbox-spec", canonicalBytes(value))), value);
  assert.throws(() => assertSpecSemantics({ ...value, sandboxName: deriveSandboxName("run_other") }), /derived/);
  assert.throws(() => buildSandboxSpec({ runId: value.runId, ticketIdentifier: value.ticketIdentifier, template: { name: value.template.name, digest: value.template.digest, reference: `${value.template.name}:latest` }, resources, network, bridgeQuotaBytes: 65_536, retention }), /immutable/);
  const invalidDisk = { ...value, resources: { ...value.resources, disk: { enforcement: "unsupported", unsupportedReason: "no proof" } } } as unknown as SandboxSpecDocument;
  assert.throws(() => assertSpecSemantics(invalidDisk), /fingerprint|quota|bridge/);
});

test("release resolution requires a validated signed exact v0.39.0 tuple", async () => {
  const resolved = fakeSandboxRelease();
  const resolver = new SandboxReleaseResolver({ releases: [resolved.release], verifySignature: () => true, observeBinary: observeFixtureBinary, platform: "linux", architecture: "x86_64" });
  const selected = await resolver.resolve({ templateName: "registry/sandbox", templateDigest, resources, networkProfileDigest, runtime });
  assert.equal(selected.release.releaseId, "fixture-release");
  await assert.rejects(() => resolver.resolve({ templateName: "registry/sandbox", templateDigest, resources, networkProfileDigest, runtime: { ...runtime, pi: { ...runtime.pi, version: "0.84.5" } } }), /exactly/);
  await assert.rejects(() => new SandboxReleaseResolver({ releases: [{ ...resolved.release, promotion: { ...resolved.release.promotion, state: "blocked" } }], verifySignature: () => true, observeBinary: observeFixtureBinary, platform: "linux", architecture: "x86_64" }).resolve({ templateName: "registry/sandbox", templateDigest }), /blocked/);
  await assert.rejects(() => new SandboxReleaseResolver({ releases: [resolved.release], verifySignature: () => false, observeBinary: observeFixtureBinary, platform: "linux", architecture: "x86_64" }).resolve({ templateName: "registry/sandbox", templateDigest }), /signature/);
  await assert.rejects(() => resolver.resolve({ templateName: "registry/sandbox", templateDigest, resources: { ...resources, cpus: 3 } }), /tuple/);
});

test("sbx adapter emits only exact argv and rejects ambient environment/output", () => {
  const executableSha256 = "a".repeat(64);
  const builder = new SbxV039CommandBuilder({ executable: "/ticket/runtime/sbx", executableSha256, cwd: "/ticket/control", environment: { PATH: "/usr/bin", HOME: "/ticket/control", LANG: "C" } });
  const created = builder.create({ sandboxName: deriveSandboxName("run_example01"), templateReference: "registry/sandbox@" + templateDigest, resources, bridgeHostPath: `/ticket/control/${deriveBridgeName("run_example01")}` });
  assert.deepEqual(created.argv, ["create", "--name", deriveSandboxName("run_example01"), "--template", "registry/sandbox@" + templateDigest, "--cpus", "2", "--memory", "512m", "--", "shell", `/ticket/control/${deriveBridgeName("run_example01")}`]);
  assert.deepEqual(builder.cpImport({ sandboxName: deriveSandboxName("run_example01"), expectedSandboxId: "vm-1", expectedTemplateDigest: templateDigest, hostPath: "/ticket/control/import-1", sandboxPath: "/ticket/import/seed.bundle" }).argv, ["cp", "/ticket/control/import-1", `${deriveSandboxName("run_example01")}:/ticket/import/seed.bundle`]);
  assert.equal(parseSbxVersionOutput("sbx version 0.39.0\n"), "0.39.0");
  assert.deepEqual(parseSbxListOutput(canonicalJson([{ name: deriveSandboxName("run_example01"), id: "id", status: "running", templateDigest, vmId: "vm" }])), [{ name: deriveSandboxName("run_example01"), id: "id", status: "running", templateDigest, vmId: "vm" }]);
  assert.throws(() => parseSbxVersionOutput("sbx version latest"), /exact/);
  assert.throws(() => parseSbxListOutput(canonicalJson([{ name: deriveSandboxName("run_example01"), id: "id", status: "running", templateDigest, vmId: "vm", extra: true }])), /closed|unknown/);
  assert.throws(() => new SbxV039CommandBuilder({ executable: "/ticket/runtime/sbx", executableSha256, cwd: "/ticket/control", environment: { ...process.env, GITHUB_TOKEN: "secret" } as Readonly<Record<string, string>> }), /environment/);
  assert.throws(() => builder.remove(deriveSandboxName("run_example01"), "bad\nidentity"), SbxCommandError);
});

test("guest protocol is canonical, framed, bound, and bounded", async () => {
  const current = binding();
  const request = makeGuestRequest(current, "canary", { marker: "x" });
  const frame = encodeGuestFrame(request);
  const decoder = new GuestFrameDecoder({ maxFrameBytes: frame.length, maxOutputBytes: frame.length * 2 });
  assert.equal(decoder.push(frame.subarray(0, 2)).length, 0);
  assert.deepEqual(decoder.push(frame.subarray(2))[0], request);
  decoder.end();
  assert.throws(() => parseGuestMessage(raw(request)), /canonically/);
  assert.throws(() => new GuestFrameDecoder({ maxFrameBytes: 1 }).push(frame), /length/);
  const worker = new FakeWorker(); const client = new GuestOperationClient(worker, current, { operationTimeoutMs: 500 });
  assert.deepEqual(await client.invoke("canary", { marker: "x" }), { ok: true });
  client.close(); await assert.rejects(() => client.invoke("canary"), /closed|ended/);
});

test("guest isolation and resource verifiers reject forged or overbroad observations", () => {
  const mountInfo = "1 0 0:1 / / rw,nosuid - rootfs rootfs rw\n2 1 0:2 / /ticket rw,nosuid - ext4 /dev/vda rw\n3 1 0:3 / /ticket/bridge rw,nosuid - virtiofs bridge rw\n4 2 0:4 / /ticket/tmp rw,nosuid,nodev,noexec - tmpfs tmpfs rw,size=65536\n";
  const isolation = new GuestIsolationCanarySuite().verify({ principal: { controllerUid: 1000, controllerGid: 1000, agentUid: 1001, agentGid: 1001, capabilities: [], agentGroups: [], sudoAvailable: false, setuidEscape: false, supervisorSocketReachable: false, rootfulDockerSocketReachable: false, noNewPrivs: true }, mount: { mountInfo, namespace: "mnt:[1]", ticketDevice: "0:2", ticketInode: "9", knownMounts: ["/ticket", "/ticket/bridge", "/ticket/tmp"], forbiddenPathsObserved: [] }, sockets: { sockets: ["/ticket/docker/run/docker.sock"], rootlessDockerSocket: "/ticket/docker/run/docker.sock", controllerSockets: [], hostSockets: [] }, environment: { environment: { HOME: "/ticket/runtime/run_example01/home", WIKI_HOME: "/ticket/runtime/run_example01/wiki-home", PI_CODING_AGENT_DIR: "/ticket/runtime/run_example01/pi-agent", PI_SKIP_VERSION_CHECK: "1", TMPDIR: "/ticket/tmp", DOCKER_HOST: "unix:///ticket/docker/run/docker.sock" }, configPaths: [], procEnvironment: { HOME: "/ticket/runtime/run_example01/home", WIKI_HOME: "/ticket/runtime/run_example01/wiki-home", PI_CODING_AGENT_DIR: "/ticket/runtime/run_example01/pi-agent", PI_SKIP_VERSION_CHECK: "1", TMPDIR: "/ticket/tmp", DOCKER_HOST: "unix:///ticket/docker/run/docker.sock" }, gitRemote: null }, canaryValues: ["delivery-canary"] }, { runId: "run_example01" });
  assert.equal(isolation.credentialsAbsent, true);
  assert.throws(() => assertMountIsolation(parseMountInfo(`${mountInfo}5 1 0:5 / /ticket/nested rw - ext4 /dev/vdb rw\n`), { mountInfo, namespace: "mnt:[1]", ticketDevice: "0:2", ticketInode: "9", knownMounts: ["/ticket", "/ticket/bridge", "/ticket/tmp"], forbiddenPathsObserved: [] }), IsolationProbeError);
  const verification = new SandboxResourceVerifier().verify(resources, { cpuOnline: 2, cpuQuotaMicros: 2, cpuPeriodMicros: 1, memoryMaxBytes: 512 * 1024 * 1024, ticketStatfsBytes: 1024, ticketQuotaBytes: 1_048_576, bridgeQuotaBytes: 65_536, writableTmpfsBytes: 65_536, diskEnforcement: "quota-composed", enospcObserved: true, writableSurfaces: ["/ticket", "/ticket/bridge", "/ticket/docker", "/ticket/runtime", "/ticket/sessions", "/ticket/artifacts", "/ticket/evidence", "/ticket/import"], hostObservation: { path: "evidence/sandbox/resource.json", sha256: "c".repeat(64), schemaId: "urn:squire:sandbox:v1:resource", hostOnly: true } });
  new SandboxResourceVerifier().assertProductionSupported(verification);
  assert.throws(() => new SandboxResourceVerifier().verify({ ...resources, cpus: 1 }, verification.observed), ResourceVerificationError);
  assert.throws(() => new SandboxResourceVerifier().verify(resources, { ...verification.observed, writableSurfaces: ["/ticket/evil"] }), /surface/);
});

test("bridge creation, canary, quota identity, quarantine, and exact removal are fail-closed", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "squire-bridge-test-")); const manager = new BridgeManager({ controllerDataRoot: root, quota: new RecordingBridgeQuotaAdministrator() });
  const record = await manager.create("run_example01", 65_536); await manager.assertEmpty("run_example01");
  const marker = randomBytes(16); await writeFile(path.join(record.path, "marker.bin"), marker, { mode: 0o600 });
  const canary = await manager.verifyProvisionCanary("run_example01", "marker.bin", sha256Bytes(marker)); assert.equal(canary.emptyAfterCleanup, true);
  await manager.quarantineAndRemove("run_example01", { writersStopped: true }); assert.equal(await manager.read("run_example01"), undefined);
  await assert.rejects(() => manager.quarantineAndRemove("run_example01", { writersStopped: false }), /writers/);
});

test("durable host supervisor records exact ownership and refuses an unhashed executable", async () => {
  const executable = process.execPath; const executableSha256 = sha256Bytes(await readFile(executable)); const supervisor = new HostProcessSupervisor({ ledger: new InMemoryHostProcessLedger(), testOnlyAllowNonSbxCommand: true });
  const result = await supervisor.run({ kind: "version", executable, executableSha256, argv: ["-e", "setTimeout(() => process.exit(0), 100)"], cwd: "/", environment: { PATH: "/usr/bin:/bin" } });
  assert.equal(result.stdout, ""); assert.equal(result.exitCode, 0); assert.match(result.processIdentity, /^host-child:/);
  await assert.rejects(() => supervisor.run({ kind: "version", executable, executableSha256: "0".repeat(64), argv: [], cwd: "/", environment: { PATH: "/usr/bin" } }), /digest/);
  assert.throws(() => new HostProcessSupervisor(), /durable/);
});

test("sandbox lifecycle creates, starts, retains, and removes only under the shared fence", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "squire-lifecycle-test-")); const store = new InMemoryWorkflowStore(); await store.create(run());
  const release = fakeSandboxRelease(); const resolver = new SandboxReleaseResolver({ releases: [release.release], verifySignature: () => true, observeBinary: observeFixtureBinary, platform: "linux", architecture: "x86_64" }); const resolvedRelease = await resolver.resolve({ templateName: "registry/sandbox", templateDigest, resources, networkProfileDigest }); const driver = new FakeSbxDriver(resolvedRelease);
  const bridge = new BridgeManager({ controllerDataRoot: path.join(root, "controller"), quota: new RecordingBridgeQuotaAdministrator() });
  const fakeAttestor: SandboxAttestorPort = new MeasuredSandboxAttestor();
  const evidence: MeasuredSandboxEvidence = { resources: { cpuOnline: 2, cpuQuotaMicros: 2, cpuPeriodMicros: 1, memoryMaxBytes: 512 * 1024 * 1024, ticketStatfsBytes: 1_024, ticketQuotaBytes: 1_048_576, bridgeQuotaBytes: 65_536, writableTmpfsBytes: 65_536, diskEnforcement: "quota-composed", enospcObserved: true, writableSurfaces: ["/ticket", "/ticket/bridge", "/ticket/docker", "/ticket/runtime", "/ticket/sessions", "/ticket/artifacts", "/ticket/evidence", "/ticket/import"], hostObservation: { path: "evidence/sandbox/resource.json", sha256: "c".repeat(64), schemaId: "urn:squire:sandbox:v1:resource", hostOnly: true } }, isolation: { principal: { controllerUid: 1000, controllerGid: 1000, agentUid: 1001, agentGid: 1001, capabilities: [], agentGroups: [], sudoAvailable: false, setuidEscape: false, supervisorSocketReachable: false, rootfulDockerSocketReachable: false, noNewPrivs: true }, mount: { mountInfo: "1 0 0:1 / / rw,nosuid - rootfs rootfs rw\n2 1 0:2 / /ticket rw,nosuid - ext4 /dev/vda rw\n3 2 0:3 / /ticket/bridge rw,nosuid - virtiofs bridge rw\n4 2 0:4 / /ticket/tmp rw,nosuid,nodev,noexec - tmpfs tmpfs rw,size=65536\n", namespace: "mnt:[1]", ticketDevice: "0:2", ticketInode: "9", knownMounts: ["/ticket", "/ticket/bridge", "/ticket/tmp"], forbiddenPathsObserved: [] }, sockets: { sockets: ["/ticket/docker/run/docker.sock"], rootlessDockerSocket: "/ticket/docker/run/docker.sock", controllerSockets: [], hostSockets: [] }, environment: { environment: { HOME: "/ticket/runtime/run_example01/home", WIKI_HOME: "/ticket/runtime/run_example01/wiki-home", PI_CODING_AGENT_DIR: "/ticket/runtime/run_example01/pi-agent", PI_SKIP_VERSION_CHECK: "1", TMPDIR: "/ticket/tmp", DOCKER_HOST: "unix:///ticket/docker/run/docker.sock" }, configPaths: [], procEnvironment: { HOME: "/ticket/runtime/run_example01/home", WIKI_HOME: "/ticket/runtime/run_example01/wiki-home", PI_CODING_AGENT_DIR: "/ticket/runtime/run_example01/pi-agent", PI_SKIP_VERSION_CHECK: "1", TMPDIR: "/ticket/tmp", DOCKER_HOST: "unix:///ticket/docker/run/docker.sock" }, gitRemote: null }, canaryValues: ["delivery-canary"] }, network: { profileDigest: networkProfileDigest, allowedHttpsCorrelationDigest: sha256Bytes(Buffer.from(canonicalJson(networkAudit.allowedHttps), "utf8")), deniedProbeDigest: sha256Bytes(Buffer.from(canonicalJson(networkAudit.denied), "utf8")), hostObservation: networkObservation, audit: networkAudit }, credentials: { canaryHmacDigest: "4".repeat(64), canaryValues: ["delivery-canary"] } };
  const evidencePort = async () => evidence;
  const service = new SandboxLifecycleService({ store, releaseResolver: resolver, driver, bridge, attestor: fakeAttestor, evidence: evidencePort, clock: new TestClock(), controllerDataRoot: path.join(root, "controller") });
  const created = await service.create({ runId: "run_example01", ticketIdentifier: "AIDEV-223", templateName: "registry/sandbox", templateDigest, resources, network, retention, creationNonce: "11111111-1111-4111-8111-111111111111" }); assert.equal(created.sandbox.lifecycle, "created");
  const ready = await service.start("run_example01"); assert.equal(ready.sandbox.lifecycle, "ready");
  const transferGeneration = await service.withTransfer("run_example01", "import", async reservation => { assert.equal(reservation.sandboxId, ready.sandbox.identity?.sandboxId); assert.equal(reservation.bootId, ready.sandbox.bootId); return reservation.transferGeneration; });
  assert.equal(transferGeneration, 1); assert.equal((await store.read("run_example01"))!.sandbox!.operation, undefined); assert.equal((await store.read("run_example01"))!.sandbox!.transferGeneration, 1);
  const current = (await store.read("run_example01"))!.sandbox!; const guest = new GuestOperationClient(new FakeWorker(), { ...binding(), sandboxId: current.identity!.sandboxId, bootId: current.bootId!, operationGeneration: current.operationGeneration }); const transfer = new SandboxTransferService({ controllerDataRoot: path.join(root, "controller"), driver, guest, lifecycle: service, seed: { readSeed: async () => ({ logicalName: "repository-seed.bundle", bytes: Buffer.from("immutable-seed", "utf8") }) } }); const imported = await transfer.importSeed({ runId: "run_example01", sandboxName: current.sandboxName, sandboxId: current.identity!.sandboxId, templateDigest: current.templateDigest, specFingerprint: current.specFingerprint, bootId: current.bootId!, transferGeneration: current.transferGeneration }); assert.equal(imported.manifest.direction, "import"); assert.equal(imported.manifest.transferGeneration, 2); assert.equal(imported.manifest.bridgeUsed, false); assert.ok(imported.hostPath.endsWith("import-2-repository-seed.bundle"));
  await assert.rejects(() => transfer.importSeed({ runId: "run_example01", sandboxName: current.sandboxName, sandboxId: current.identity!.sandboxId, templateDigest: current.templateDigest, specFingerprint: current.specFingerprint, bootId: current.bootId!, transferGeneration: current.transferGeneration }), /stale|replayed|different lifecycle identity/);
  await assert.rejects(() => service.withTransfer("run_example01", "export", async () => { throw new Error("simulated transfer crash"); }), /simulated transfer crash/);
  const crashed = (await store.read("run_example01"))!.sandbox!; assert.equal(crashed.operation?.kind, "transfer");
  const recovery = new SandboxRecoveryService(driver, service); assert.equal((await recovery.inspect("run_example01", crashed)).disposition, "blocked");
  const { operation: _operation, ...withoutTransfer } = crashed; const crashedSnapshot = (await store.read("run_example01"))!; await store.compareAndSet("run_example01", { version: crashedSnapshot.version }, snapshot => ({ ...snapshot, version: snapshot.version + 1, sandbox: withoutTransfer }));
  guest.close();
  const retained = await service.retain("run_example01", "failure"); assert.equal(retained.sandbox.lifecycle, "retained");
  const teardown = await store.beginRunTeardown("run_example01", "teardown-owner", "retention"); assert.equal(teardown.state, "draining"); const fence = await store.acquireRunTerminalFence("run_example01", "teardown-owner");
  const removed = await service.remove("run_example01", { fence, writersStopped: true }); assert.equal(removed.sandbox.lifecycle, "removed"); await store.completeRunTeardown("run_example01", fence); assert.equal((await store.read("run_example01"))!.terminalFence!.state, "removed");
});

test("sandbox public composition excludes raw sbx and guest-control internals", async () => {
  const publicApi = await import("../src/index.js");
  assert.equal(Object.hasOwn(publicApi, "SbxV039CommandBuilder"), false);
  assert.equal(Object.hasOwn(publicApi, "GuestOperationClient"), false);
  assert.equal(Object.hasOwn(publicApi, "BridgeManager"), false);
  assert.equal(typeof publicApi.SandboxLifecycleService, "function");
  assert.equal(typeof publicApi.SandboxPiProcessFactory, "function");
});
