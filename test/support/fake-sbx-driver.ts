import type { SandboxReleaseManifestDocument, SandboxSpecDocument } from "../../src/sandbox/domain.js";
import type { ResolvedSandboxRelease } from "../../src/sandbox/release-resolver.js";
import type { SandboxDriver, SbxExecHandle, SbxPolicyObservation } from "../../src/sandbox/sbx-v039-driver.js";
import type { SbxCopyCommandInput, SbxObservedSandbox } from "../../src/sandbox/sbx-command.js";
import type { HostChildProcess, SbxCommandResult } from "../../src/sandbox/host-process-supervisor.js";
import { canonicalJson, sha256Bytes } from "../../src/sandbox/identity.js";

export function fakeSandboxRelease(overrides: Partial<SandboxReleaseManifestDocument> = {}): ResolvedSandboxRelease {
  const templateDigest = "sha256:" + "a".repeat(64); const proof = { path: "evidence/sandbox/resource.json", sha256: "b".repeat(64), schemaId: "urn:squire:sandbox:v1:resource" };
  const resourceTuple = { tupleId: "small", cpus: 2, memoryMiB: 512, disk: { enforcement: "quota-composed" as const, ticketQuotaBytes: 1_048_576, bridgeQuotaBytes: 65_536, writableTmpfsBytes: 65_536, proof } };
  const release: SandboxReleaseManifestDocument = {
    schemaVersion: 1, kind: "squire-sandbox-release-manifest", releaseId: "fixture-release", sbxVersion: "0.39.0", platform: "linux", architecture: "x86_64",
    sbxBinary: { path: "/ticket/runtime/sbx", sha256: "c".repeat(64), versionOutput: "sbx version 0.39.0", helpDigest: "d".repeat(64) },
    template: { reference: `registry/sandbox@${templateDigest}`, digest: templateDigest, configDigest: "e".repeat(64), helperDigests: ["f".repeat(64)] },
    runtimeCompatibility: { pi: { minimum: "0.84.4", maximum: "0.84.4" }, llmWiki: { minimum: "0.11.8", maximum: "0.11.8" } },
    supportedResources: [resourceTuple], bridgeQuotaBytes: 65_536, networkProfileDigest: "eaf2d7d4d6f5159b028304905892bb7c0ac15b8e35219cb6dd3e2d9a140d52a3", conformanceEvidence: [{ kind: "host-conformance", platform: "linux", architecture: "x86_64", path: "evidence/sandbox/fixture.json", sha256: "2".repeat(64), hostOnly: true }],
    provenance: { buildReference: "fixture-build", sbomReference: "fixture-sbom" }, promotion: { state: "validated", algorithm: "ed25519", keyId: "fixture-key", signature: "fixture-signature-012345" },
    ...overrides,
  };
  // This fixture is deliberately not resolver-verified; production drivers
  // must obtain the private proof from SandboxReleaseResolver.resolve().
  return { release, templateReference: release.template.reference, sbxExecutable: release.sbxBinary.path, resourceTuple: release.supportedResources[0]! } as unknown as ResolvedSandboxRelease;
}

export class FakeSbxDriver implements SandboxDriver {
  readonly release: ResolvedSandboxRelease;
  readonly records = new Map<string, SbxObservedSandbox>();
  readonly calls: string[] = [];
  #sequence = 0;
  constructor(release = fakeSandboxRelease()) { this.release = release; }
  async inspect(name: string): Promise<SbxObservedSandbox | undefined> { this.calls.push(`inspect:${name}`); const value = this.records.get(name); return value ? structuredClone(value) : undefined; }
  async create(spec: SandboxSpecDocument, _bridgeHostPath: string): Promise<SbxObservedSandbox> { this.calls.push(`create:${spec.sandboxName}`); const existing = this.records.get(spec.sandboxName); if (existing) return structuredClone(existing); const value: SbxObservedSandbox = { name: spec.sandboxName, id: `sandbox-${++this.#sequence}`, status: "created", templateDigest: spec.template.digest, vmId: `vm-${this.#sequence}` }; this.records.set(value.name, value); return structuredClone(value); }
  async start(expected: SbxObservedSandbox): Promise<SbxObservedSandbox> { this.calls.push(`start:${expected.name}`); const current = this.records.get(expected.name); if (!current || current.id !== expected.id) throw new Error("fake sandbox identity mismatch"); const value = { ...current, status: "running" as const, bootId: `boot-${++this.#sequence}` }; this.records.set(value.name, value); return structuredClone(value); }
  async stop(expected: SbxObservedSandbox): Promise<SbxObservedSandbox> { this.calls.push(`stop:${expected.name}`); const current = this.records.get(expected.name); if (!current || current.id !== expected.id) throw new Error("fake sandbox identity mismatch"); const { bootId: _bootId, ...withoutBoot } = current; const value = { ...withoutBoot, status: "stopped" as const }; this.records.set(value.name, value); return structuredClone(value); }
  async execWorker(_expected: SbxObservedSandbox): Promise<SbxExecHandle> { throw new Error("fake sbx worker is not configured"); }
  async cpImport(input: SbxCopyCommandInput): Promise<SbxCommandResult> { this.calls.push(`cp-import:${input.sandboxName}`); return fakeCommandResult(); }
  async cpExport(input: SbxCopyCommandInput): Promise<SbxCommandResult> { this.calls.push(`cp-export:${input.sandboxName}`); return fakeCommandResult(); }
  async remove(expected: SbxObservedSandbox): Promise<void> { this.calls.push(`remove:${expected.name}`); const current = this.records.get(expected.name); if (!current || current.id !== expected.id) throw new Error("fake sandbox identity mismatch"); this.records.delete(expected.name); }
  async policy(): Promise<SbxPolicyObservation> { return { digest: this.release.release.networkProfileDigest, mode: "deny-all", allowedHosts: [], source: "host" }; }
}
function fakeCommandResult(): SbxCommandResult { return { commandId: "fake-command", commandFingerprint: sha256Bytes(Buffer.from(canonicalJson({ fake: true }), "utf8")), argv: [], executable: "/ticket/runtime/sbx", processIdentity: "fake-process", exitCode: 0, signal: null, stdout: "", stderr: "" }; }
