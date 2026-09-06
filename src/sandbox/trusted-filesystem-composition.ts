import type { FileHandle } from "node:fs/promises";
import { assertTrustedFilesystemOperation, closeTrustedFilesystemIsolationAuthority, composeTrustedFilesystemIsolationAuthority, trustedFilesystemObservation, type TrustedFilesystemIsolationAuthority } from "../git/trusted-isolation.js";
import type { GuestOperationClient } from "./guest-protocol.js";
import { assertCanonicalSandboxPath, assertSha256 } from "./identity.js";

export interface GuestFilesystemProof {
  readonly ticketRoot: string;
  readonly controllerUid: number;
  readonly controllerGid: number;
  readonly agentUid: number;
  readonly agentGid: number;
  readonly mountNamespace: string;
  readonly ticketDevice: string;
  readonly ticketInode: string;
  readonly mountInfoDigest: string;
  readonly nestedMounts: 0;
  readonly forbiddenMounts: 0;
  readonly retainedDescriptors: readonly ["proc", "namespace", "mountinfo"];
  readonly roleCapabilities: readonly string[];
  readonly roleWritablePaths: readonly string[];
}

export interface SandboxFilesystemComposition {
  readonly authority: TrustedFilesystemIsolationAuthority;
  readonly proof: GuestFilesystemProof;
  readonly ticketRoot: string;
  assertOperation(signal?: AbortSignal): Promise<void>;
  close(): Promise<void>;
}

export class TrustedFilesystemCompositionError extends Error {
  constructor(message: string) { super(message); this.name = "TrustedFilesystemCompositionError"; }
}

// The guest proof reports directory roots, not arbitrary descendants.  Keep
// this inventory closed so a forged proof cannot expand the role's writable
// surface by naming a controller subtree below an otherwise permitted root.
const ROLE_WRITABLE_ROOTS = new Set([
  "/ticket/workspace",
  "/ticket/sessions",
  "/ticket/runtime",
  "/ticket/docker",
  "/ticket/tmp",
]);

/** Composes, rather than reimplements, AIDEV-222's descriptor-backed
 * authority. The worker must return measured proof before the authority is
 * issued; a role-provided token or boolean cannot satisfy this API. */
export async function composeSandboxFilesystemAuthority(channel: GuestOperationClient, ticketRoot = "/ticket", expected: { readonly runId?: string } = {}): Promise<SandboxFilesystemComposition> {
  if (!channel || typeof channel.invoke !== "function" || !expected || typeof expected !== "object" || Array.isArray(expected) || Object.keys(expected).some(key => key !== "runId")) throw new TrustedFilesystemCompositionError("sandbox filesystem composition requires a closed guest channel and expectation");
  assertCanonicalSandboxPath(ticketRoot, "ticket root");
  if (ticketRoot !== "/ticket") throw new TrustedFilesystemCompositionError("sandbox filesystem composition is fixed to /ticket");
  if (expected.runId !== undefined && (typeof expected.runId !== "string" || !/^run_[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(expected.runId))) throw new TrustedFilesystemCompositionError("sandbox filesystem expected run identity is invalid");
  const response = await channel.invoke("verify-paths", { ticketRoot, ...(expected.runId !== undefined ? { runId: expected.runId } : {}) });
  const proof = validateGuestFilesystemProof(response, ticketRoot, expected.runId);
  let authority: TrustedFilesystemIsolationAuthority;
  try { authority = await composeTrustedFilesystemIsolationAuthority(ticketRoot); }
  catch (error) { throw new TrustedFilesystemCompositionError(error instanceof Error ? error.message : String(error)); }
  const actual = trustedFilesystemObservation(authority, ticketRoot);
  if (proof.controllerUid !== 1000 || proof.controllerGid !== 1000 || proof.agentUid !== 1001 || proof.agentGid !== 1001 || proof.mountNamespace !== actual.namespace || proof.ticketDevice !== actual.device || proof.ticketInode !== actual.inode || proof.mountInfoDigest !== actual.mountFingerprint) {
    await closeTrustedFilesystemIsolationAuthority(authority).catch(() => undefined);
    throw new TrustedFilesystemCompositionError("guest filesystem proof does not match the live descriptor-backed authority");
  }
  let closed = false;
  return {
    authority,
    proof,
    ticketRoot,
    async assertOperation(signal?: AbortSignal): Promise<void> {
      if (closed) throw new TrustedFilesystemCompositionError("sandbox filesystem composition is closed");
      await assertTrustedFilesystemOperation(authority, ticketRoot, signal);
    },
    async close(): Promise<void> { if (closed) return; closed = true; await closeTrustedFilesystemIsolationAuthority(authority); },
  };
}

export function validateGuestFilesystemProof(value: unknown, ticketRoot = "/ticket", expectedRunId?: string): GuestFilesystemProof {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TrustedFilesystemCompositionError("guest filesystem proof is not an object");
  const record = value as Record<string, unknown>;
  const expectedKeys = ["agentGid", "agentUid", "controllerGid", "controllerUid", "forbiddenMounts", "mountInfoDigest", "mountNamespace", "nestedMounts", "retainedDescriptors", "roleCapabilities", "roleWritablePaths", "ticketDevice", "ticketInode", "ticketRoot"].sort();
  if (Object.keys(record).sort().join("\0") !== expectedKeys.join("\0") || record["ticketRoot"] !== ticketRoot || !Number.isSafeInteger(record["controllerUid"]) || !Number.isSafeInteger(record["controllerGid"]) || !Number.isSafeInteger(record["agentUid"]) || !Number.isSafeInteger(record["agentGid"]) || typeof record["mountNamespace"] !== "string" || typeof record["ticketDevice"] !== "string" || typeof record["ticketInode"] !== "string" || record["nestedMounts"] !== 0 || record["forbiddenMounts"] !== 0 || !Array.isArray(record["retainedDescriptors"]) || JSON.stringify(record["retainedDescriptors"]) !== JSON.stringify(["proc", "namespace", "mountinfo"]) || !Array.isArray(record["roleCapabilities"]) || !Array.isArray(record["roleWritablePaths"]) || record["roleCapabilities"].length !== 0) throw new TrustedFilesystemCompositionError("guest filesystem proof is not the closed measured tuple");
  if (typeof record["mountInfoDigest"] !== "string") throw new TrustedFilesystemCompositionError("guest mount evidence digest is not a string");
  assertSha256(record["mountInfoDigest"], "guest mount evidence digest");
  if (record["controllerUid"] !== 1000 || record["controllerGid"] !== 1000 || record["agentUid"] !== 1001 || record["agentGid"] !== 1001 || record["mountNamespace"] === "" || record["ticketDevice"] === "" || record["ticketInode"] === "" || [record["mountNamespace"], record["ticketDevice"], record["ticketInode"]].some(item => typeof item !== "string" || item.length > 512 || /[\u0000-\u001f\u007f\r\n]/u.test(item)) || !/^mnt:\[\d+\]$/u.test(record["mountNamespace"] as string) || !/^\d+:\d+$/u.test(record["ticketDevice"] as string) || !/^\d+$/u.test(record["ticketInode"] as string)) throw new TrustedFilesystemCompositionError("guest filesystem proof does not separate controller and role identities");
  if (expectedRunId !== undefined && !/^run_[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(expectedRunId)) throw new TrustedFilesystemCompositionError("guest filesystem proof expected run identity is invalid");
  const writable = record["roleWritablePaths"] as unknown[];
  const expectedWritable = [...ROLE_WRITABLE_ROOTS].sort();
  if (writable.length !== expectedWritable.length || new Set(writable).size !== writable.length || writable.some(item => typeof item !== "string" || !ROLE_WRITABLE_ROOTS.has(item) || !isCanonicalPath(item)) || [...writable].sort().join("\0") !== expectedWritable.join("\0") || (record["roleCapabilities"] as unknown[]).some(item => typeof item !== "string" || item.length > 256 || /[\u0000-\u001f\u007f\r\n]/u.test(item))) throw new TrustedFilesystemCompositionError("guest role writable path inventory includes a protected or non-canonical path");
  return Object.freeze({ ...record, retainedDescriptors: Object.freeze([...(record["retainedDescriptors"] as string[])]), roleCapabilities: Object.freeze([...(record["roleCapabilities"] as string[])]), roleWritablePaths: Object.freeze([...(record["roleWritablePaths"] as string[])]) }) as unknown as GuestFilesystemProof;
}

/** Compile-time marker documenting that descriptor ownership is held by the
 * AIDEV-222 authority, not by the sandbox role. */
export type TrustedDescriptorSet = readonly [FileHandle, FileHandle, FileHandle];
function isCanonicalPath(value: string): boolean { try { assertCanonicalSandboxPath(value); return true; } catch { return false; } }
