import { createHash } from "node:crypto";
import type { SandboxDiskBudget, SandboxResourceSpec } from "./domain.js";
import { SandboxContractError } from "./contracts.js";
import { assertCanonicalSandboxPath, assertDiskBudget, canonicalJson, isCanonicalSandboxPath, isSandboxEvidenceSchemaId, sha256Bytes, SANDBOX_RESOURCE_EVIDENCE_SCHEMA_ID } from "./identity.js";

export interface CgroupResourceObservation {
  readonly cpuOnline: number;
  readonly cpuQuotaMicros?: number;
  readonly cpuPeriodMicros?: number;
  readonly cpusetCpus?: readonly number[];
  readonly memoryMaxBytes: number;
  readonly ticketStatfsBytes: number;
  readonly ticketQuotaBytes?: number;
  readonly bridgeQuotaBytes?: number;
  readonly writableTmpfsBytes?: number;
  /** Independently measured native filesystem/project limit; never inferred from statfs free space. */
  readonly nativeLimitBytes?: number;
  readonly diskEnforcement: "native" | "quota-composed" | "unsupported";
  readonly enospcObserved: boolean;
  readonly writableSurfaces: readonly string[];
  readonly hostObservation?: { readonly path: string; readonly sha256: string; readonly schemaId: typeof SANDBOX_RESOURCE_EVIDENCE_SCHEMA_ID; readonly hostOnly: true };
}

export interface ResourceVerification {
  readonly requested: SandboxResourceSpec;
  readonly observed: CgroupResourceObservation;
  readonly effectiveCpuLimit: number;
  readonly memoryBoundBytes: number;
  readonly diskBoundBytes?: number;
  readonly proofDigest: string;
  readonly supported: true;
}

export class ResourceVerificationError extends Error {
  constructor(message: string) { super(message); this.name = "ResourceVerificationError"; }
}

export class SandboxResourceVerifier {
  readonly #memoryToleranceBytes: number;
  constructor(options: { readonly memoryToleranceBytes?: number } = {}) {
    this.#memoryToleranceBytes = options.memoryToleranceBytes ?? 0;
    if (this.#memoryToleranceBytes !== 0) throw new ResourceVerificationError("memory tolerance is unsupported; resource memory must be exact");
  }

  verify(requested: SandboxResourceSpec, observed: CgroupResourceObservation): ResourceVerification {
    if (!isRecord(requested) || !hasExactKeys(requested, ["cpus", "disk", "memoryMiB"]) || !isRecord(requested.disk) || !isRecord(observed)) throw new ResourceVerificationError("resource verification input is malformed");
    if (!Number.isSafeInteger(requested.cpus) || requested.cpus < 1 || requested.cpus > 256 || !Number.isSafeInteger(requested.memoryMiB) || requested.memoryMiB < 128 || requested.memoryMiB > 1_048_576 || !["native", "quota-composed", "unsupported"].includes(requested.disk.enforcement as string)) throw new ResourceVerificationError("resource verification input is malformed");
    try { assertDiskBudget(requested.disk as SandboxResourceSpec["disk"]); } catch (error) { throw new ResourceVerificationError(error instanceof Error ? error.message : "resource disk tuple is malformed"); }
    assertObservationShape(observed);
    if (observed.cpuQuotaMicros === undefined && observed.cpusetCpus === undefined) throw new ResourceVerificationError("resource verification lacks an independent CPU quota or cpuset bound");
    if (!Number.isSafeInteger(observed.cpuOnline) || observed.cpuOnline !== requested.cpus || observed.cpuOnline < 1 || observed.cpuOnline > 256) throw new ResourceVerificationError("guest online CPU observation does not exactly match the requested tuple");
    const effectiveCpuLimit = effectiveCpuCount(observed);
    if (!Number.isFinite(effectiveCpuLimit) || Math.abs(effectiveCpuLimit - requested.cpus) > 1e-9) throw new ResourceVerificationError("cgroup CPU quota/cpuset does not prove the exact requested CPU bound");
    const memoryRequestedBytes = requested.memoryMiB * 1024 * 1024;
    if (!Number.isSafeInteger(observed.memoryMaxBytes) || observed.memoryMaxBytes <= 0 || observed.memoryMaxBytes > MAX_DISK_BYTES || Math.abs(observed.memoryMaxBytes - memoryRequestedBytes) > this.#memoryToleranceBytes) throw new ResourceVerificationError("cgroup memory.max does not prove the exact requested memory tuple");
    if (!Number.isSafeInteger(observed.ticketStatfsBytes) || observed.ticketStatfsBytes < 0 || observed.ticketStatfsBytes > MAX_DISK_BYTES) throw new ResourceVerificationError("ticket statfs observation is invalid");
    if (!Array.isArray(observed.writableSurfaces)) throw new ResourceVerificationError("writable surface inventory is not an array");
    const surfaces = [...observed.writableSurfaces];
    if (surfaces.length !== KNOWN_WRITABLE_SURFACES.size || new Set(surfaces).size !== surfaces.length || surfaces.some(surface => typeof surface !== "string" || !/^\/ticket(?:\/[A-Za-z0-9._-]+)*$/u.test(surface) || /[\u0000-\u001f\u007f]/u.test(surface) || !isCanonicalSandboxPath(surface)) || [...KNOWN_WRITABLE_SURFACES].some(surface => !surfaces.includes(surface))) throw new ResourceVerificationError("writable surface inventory is not the complete closed quota composition");
    const diskBoundBytes = this.#verifyDisk(requested.disk, observed);
    const requestedCopy = deepFreeze(structuredClone(requested));
    const observedCopy = deepFreeze(structuredClone({ ...observed, writableSurfaces: surfaces }));
    const proof = { requested: requestedCopy, observed: observedCopy };
    return { requested: requestedCopy, observed: observedCopy, effectiveCpuLimit, memoryBoundBytes: observed.memoryMaxBytes, ...(diskBoundBytes !== undefined ? { diskBoundBytes } : {}), proofDigest: sha256Bytes(Buffer.from(canonicalJson(proof), "utf8")), supported: true };
  }

  /** A disk quota request or free-space reading is never enough. This method is
   * the explicit release gate for platforms with no proof. */
  assertProductionSupported(verification: ResourceVerification): void {
    if (!verification || verification.supported !== true || !verification.requested || !verification.observed) throw new ResourceVerificationError("resource verification result is malformed");
    const rechecked = this.verify(verification.requested, verification.observed);
    if (rechecked.proofDigest !== verification.proofDigest || rechecked.diskBoundBytes !== verification.diskBoundBytes) throw new ResourceVerificationError("resource verification result was substituted after measurement");
    const host = rechecked.observed.hostObservation;
    if (rechecked.observed.diskEnforcement === "unsupported" || rechecked.diskBoundBytes === undefined || !rechecked.observed.enospcObserved || !host || host.hostOnly !== true || !/^[0-9a-f]{64}$/u.test(host.sha256) || !isEvidencePath(host.path) || !isSandboxEvidenceSchemaId(host.schemaId, "resource")) throw new ResourceVerificationError("resource tuple is unsupported: disk enforcement, ENOSPC, and independent host proof are required");
  }

  #verifyDisk(requested: SandboxDiskBudget, observed: CgroupResourceObservation): number | undefined {
    if (requested.enforcement !== observed.diskEnforcement) throw new ResourceVerificationError("observed disk enforcement mode differs from the requested tuple");
    if (observed.writableSurfaces.some(surface => !KNOWN_WRITABLE_SURFACES.has(surface))) throw new ResourceVerificationError("agent-writable surface is outside the supported quota composition");
    if (requested.enforcement === "unsupported") {
      if (observed.ticketQuotaBytes !== undefined || observed.bridgeQuotaBytes !== undefined || observed.writableTmpfsBytes !== undefined || observed.nativeLimitBytes !== undefined || observed.enospcObserved) throw new ResourceVerificationError("unsupported disk tuple was given an unverified enforcement claim");
      return undefined;
    }
    if (!observed.enospcObserved) throw new ResourceVerificationError("bounded disk probe did not observe ENOSPC at the enforced boundary");
    if (requested.enforcement === "native") {
      if (requested.nativeLimitBytes === undefined || requested.writableTmpfsBytes === undefined || observed.nativeLimitBytes !== requested.nativeLimitBytes || observed.writableTmpfsBytes !== requested.writableTmpfsBytes || observed.ticketQuotaBytes !== undefined || observed.bridgeQuotaBytes !== undefined) throw new ResourceVerificationError("native disk proof is incomplete");
      return requested.nativeLimitBytes;
    }
    if (observed.nativeLimitBytes !== undefined || requested.ticketQuotaBytes === undefined || requested.bridgeQuotaBytes === undefined || requested.writableTmpfsBytes === undefined || observed.ticketQuotaBytes !== requested.ticketQuotaBytes || observed.bridgeQuotaBytes !== requested.bridgeQuotaBytes || observed.writableTmpfsBytes !== requested.writableTmpfsBytes) throw new ResourceVerificationError("quota-composed disk proof does not match every requested writable surface");
    if (observed.writableSurfaces.some(surface => !KNOWN_WRITABLE_SURFACES.has(surface))) throw new ResourceVerificationError("agent-writable persistent surface is outside the quota composition");
    return requested.ticketQuotaBytes + requested.bridgeQuotaBytes + requested.writableTmpfsBytes;
  }
}

export function effectiveCpuCount(observed: Pick<CgroupResourceObservation, "cpuOnline" | "cpuQuotaMicros" | "cpuPeriodMicros" | "cpusetCpus">): number {
  if (!observed || typeof observed !== "object" || !Number.isSafeInteger(observed.cpuOnline) || observed.cpuOnline < 1 || observed.cpuOnline > 256) throw new ResourceVerificationError("cgroup CPU online observation is invalid");
  let result = observed.cpuOnline;
  if (observed.cpuQuotaMicros !== undefined || observed.cpuPeriodMicros !== undefined) {
    const quota = observed.cpuQuotaMicros;
    const period = observed.cpuPeriodMicros;
    if (quota === undefined || period === undefined || !Number.isSafeInteger(quota) || !Number.isSafeInteger(period) || quota <= 0 || period <= 0 || quota > 1_000_000_000 || period > 1_000_000_000) throw new ResourceVerificationError("cgroup CPU quota observation is incomplete");
    result = Math.min(result, quota / period);
  }
  if (observed.cpusetCpus !== undefined) {
    if (!Array.isArray(observed.cpusetCpus) || observed.cpusetCpus.length === 0 || observed.cpusetCpus.length > 256 || observed.cpusetCpus.some(cpu => !Number.isSafeInteger(cpu) || cpu < 0 || cpu > 65_535) || new Set(observed.cpusetCpus).size !== observed.cpusetCpus.length) throw new ResourceVerificationError("cgroup cpuset observation is invalid");
    result = Math.min(result, observed.cpusetCpus.length);
  }
  return result;
}

export interface DiskFillProbeResult {
  readonly attemptedBytes: number;
  readonly writtenBytes: number;
  readonly enospcObserved: boolean;
  readonly statfsBefore: number;
  readonly statfsAfter: number;
  readonly quotaBytes?: number;
  readonly proofDigest: string;
}

export function validateDiskFillProbe(result: DiskFillProbeResult, expectedQuotaBytes?: number): void {
  if (!isRecord(result) || !hasExactKeys(result, Object.hasOwn(result, "quotaBytes") ? ["attemptedBytes", "enospcObserved", "proofDigest", "quotaBytes", "statfsAfter", "statfsBefore", "writtenBytes"] : ["attemptedBytes", "enospcObserved", "proofDigest", "statfsAfter", "statfsBefore", "writtenBytes"]) || !Number.isSafeInteger(result.attemptedBytes) || !Number.isSafeInteger(result.writtenBytes) || result.attemptedBytes <= 0 || result.attemptedBytes > 1_099_511_627_776 || result.writtenBytes <= 0 || result.writtenBytes >= result.attemptedBytes || result.enospcObserved !== true || !Number.isSafeInteger(result.statfsBefore) || !Number.isSafeInteger(result.statfsAfter) || result.statfsBefore < 0 || result.statfsBefore > 1_099_511_627_776 || result.statfsAfter < 0 || result.statfsAfter > result.statfsBefore) throw new ResourceVerificationError("disk fill probe did not produce bounded ENOSPC evidence");
  if (result.quotaBytes !== undefined && (!Number.isSafeInteger(result.quotaBytes) || result.quotaBytes < 4096 || result.quotaBytes > 1_099_511_627_776) || expectedQuotaBytes !== undefined && result.quotaBytes !== expectedQuotaBytes) throw new ResourceVerificationError("disk fill probe quota differs from the accepted tuple");
  if (!/^[0-9a-f]{64}$/u.test(result.proofDigest) || result.proofDigest !== diskProbeDigest({ attemptedBytes: result.attemptedBytes, writtenBytes: result.writtenBytes, enospcObserved: result.enospcObserved, statfsBefore: result.statfsBefore, statfsAfter: result.statfsAfter, ...(result.quotaBytes !== undefined ? { quotaBytes: result.quotaBytes } : {}) })) throw new ResourceVerificationError("disk fill probe proof digest is invalid");
}

export function diskProbeDigest(result: Omit<DiskFillProbeResult, "proofDigest">): string {
  return createHash("sha256").update(canonicalJson(result), "utf8").digest("hex");
}

const MAX_DISK_BYTES = 1_099_511_627_776;
const MAX_BRIDGE_BYTES = 107_374_182_400;
const KNOWN_WRITABLE_SURFACES = new Set(["/ticket", "/ticket/bridge", "/ticket/docker", "/ticket/runtime", "/ticket/sessions", "/ticket/artifacts", "/ticket/evidence", "/ticket/import"]);
function assertObservationShape(observed: CgroupResourceObservation): void {
  const record = observed as unknown as Record<string, unknown>;
  const required = ["cpuOnline", "diskEnforcement", "enospcObserved", "memoryMaxBytes", "ticketStatfsBytes", "writableSurfaces"];
  const optional = ["bridgeQuotaBytes", "cpusetCpus", "cpuPeriodMicros", "cpuQuotaMicros", "hostObservation", "nativeLimitBytes", "ticketQuotaBytes", "writableTmpfsBytes"];
  const allowed = [...required, ...optional];
  if (!isRecord(record) || Object.keys(record).some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(record, key)) || !["native", "quota-composed", "unsupported"].includes(String(record["diskEnforcement"])) || typeof record["enospcObserved"] !== "boolean" || !Number.isSafeInteger(record["cpuOnline"]) || !Number.isSafeInteger(record["memoryMaxBytes"]) || Number(record["memoryMaxBytes"]) < 0 || Number(record["memoryMaxBytes"]) > MAX_DISK_BYTES || !Number.isSafeInteger(record["ticketStatfsBytes"]) || Number(record["ticketStatfsBytes"]) < 0 || Number(record["ticketStatfsBytes"]) > MAX_DISK_BYTES || !Array.isArray(record["writableSurfaces"])) throw new ResourceVerificationError("resource observation is not a closed measured tuple");
  const maxByKey: Record<string, number> = { cpuQuotaMicros: 1_000_000_000, cpuPeriodMicros: 1_000_000_000, ticketQuotaBytes: MAX_DISK_BYTES, bridgeQuotaBytes: MAX_BRIDGE_BYTES, writableTmpfsBytes: MAX_DISK_BYTES, nativeLimitBytes: MAX_DISK_BYTES };
  for (const key of Object.keys(maxByKey)) if (record[key] !== undefined && (!Number.isSafeInteger(record[key]) || Number(record[key]) <= 0 || Number(record[key]) > maxByKey[key]!)) throw new ResourceVerificationError("resource observation contains an invalid bound");
  if (record["hostObservation"] !== undefined) {
    const host = record["hostObservation"];
    if (!isRecord(host) || !hasExactKeys(host, ["hostOnly", "path", "schemaId", "sha256"]) || host["hostOnly"] !== true || !isEvidencePath(host["path"]) || typeof host["sha256"] !== "string" || !/^[0-9a-f]{64}$/u.test(host["sha256"]) || !isSandboxEvidenceSchemaId(host["schemaId"], "resource")) throw new ResourceVerificationError("resource host observation is not an exact host-only reference");
  }
}
function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean { return Object.keys(value).sort().join("\0") === [...keys].sort().join("\0"); }
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function isEvidencePath(value: unknown): value is string { return typeof value === "string" && /^(?:artifacts|evidence)(?:\/[A-Za-z0-9._-]+)+$/u.test(value) && value.split("/").every(part => part !== "." && part !== ".."); }
function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T { if (!value || typeof value !== "object" || seen.has(value as object)) return value; seen.add(value as object); for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child, seen); return Object.freeze(value); }
