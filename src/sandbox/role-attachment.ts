import { ROLES, type Role } from "../control/domain.js";
import type { RoleAttachmentDescriptor } from "./domain.js";
import { SandboxPiProcess, roleAttachmentDescriptor } from "./pi-process-factory.js";
import { assertSandboxName, assertSandboxRunId, assertCanonicalSandboxPath, canonicalJson, deriveSandboxName } from "./identity.js";

export class RoleAttachmentError extends Error {
  constructor(message: string) { super(message); this.name = "RoleAttachmentError"; }
}

/** AIDEV-217 receives this immutable descriptor and owns tab creation. No
 * Herdr socket, UI mutation, or host process handle crosses this port. */
export function buildRoleAttachmentDescriptor(input: { readonly runId: string; readonly role: Role; readonly process: SandboxPiProcess; readonly sessionId: string; readonly sessionFile: string }): RoleAttachmentDescriptor {
  if (!input || typeof input !== "object") throw new RoleAttachmentError("role attachment input is required");
  try { assertSandboxRunId(input.runId); if (!ROLES.includes(input.role)) throw new RoleAttachmentError("role is not allowlisted"); if (!input.process) throw new RoleAttachmentError("role attachment process is required"); assertSandboxName(input.process.allocation.sandboxName); assertCanonicalSandboxPath(input.sessionFile, "role session file"); }
  catch (error) { throw new RoleAttachmentError(error instanceof Error ? error.message : "role attachment identity is invalid"); }
  if (input.process.runId !== input.runId || input.process.allocation.sandboxName !== deriveSandboxName(input.runId) || input.process.exitCode !== null || !input.sessionId || input.sessionId.length > 256 || /[\u0000-\u001f\u007f\r\n]/u.test(input.sessionId) || !input.sessionFile.startsWith(`/ticket/sessions/${input.role}/`) || !/^[A-Za-z0-9._-]+$/u.test(input.sessionFile.slice(`/ticket/sessions/${input.role}/`.length))) throw new RoleAttachmentError("role attachment process is not live or session identity is invalid");
  const descriptor = roleAttachmentDescriptor(input);
  if (descriptor.runId !== input.runId || descriptor.sessionId !== input.sessionId || descriptor.sessionFile !== input.sessionFile || descriptor.runnerCommand.length !== 3) throw new RoleAttachmentError("role attachment descriptor is not exact");
  return descriptor;
}

function assertAttachmentDescriptor(descriptor: RoleAttachmentDescriptor): void {
  if (!descriptor || typeof descriptor !== "object" || Object.keys(descriptor).sort().join("\0") !== ["allocationId", "bootId", "generation", "role", "runId", "runnerCommand", "sandboxId", "sandboxName", "sessionFile", "sessionId"].sort().join("\0")) throw new RoleAttachmentError("role attachment descriptor is not closed");
  assertSandboxRunId(descriptor.runId); if (!ROLES.includes(descriptor.role)) throw new RoleAttachmentError("role attachment role is not allowlisted"); assertSandboxName(descriptor.sandboxName);
  if (descriptor.sandboxName !== deriveSandboxName(descriptor.runId) || !safeIdentity(descriptor.sandboxId) || !safeIdentity(descriptor.bootId) || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(descriptor.allocationId) || !Number.isSafeInteger(descriptor.generation) || descriptor.generation < 1 || descriptor.generation > 2_147_483_647 || typeof descriptor.sessionId !== "string" || descriptor.sessionId.length === 0 || descriptor.sessionId.length > 256 || /[\u0000-\u001f\u007f\r\n]/u.test(descriptor.sessionId) || !Array.isArray(descriptor.runnerCommand) || descriptor.runnerCommand.length !== 3 || descriptor.runnerCommand[0] !== "sandbox-pi" || descriptor.runnerCommand[1] !== descriptor.role || typeof descriptor.runnerCommand[2] !== "string" || descriptor.runnerCommand[2].length > 2_048 || !/^sandbox-pi:[^:\u0000-\u001f\u007f]{1,512}:[^:\u0000-\u001f\u007f]{1,512}:[^:\u0000-\u001f\u007f]{1,512}:[A-Za-z0-9][A-Za-z0-9._-]{0,127}:\d{1,10}:\d{1,10}:\d{1,32}:\d{1,10}:[0-9a-f]{64}$/u.test(descriptor.runnerCommand[2])) throw new RoleAttachmentError("role attachment process identity is malformed");
  assertCanonicalSandboxPath(descriptor.sessionFile, "role session file"); if (!descriptor.sessionFile.startsWith(`/ticket/sessions/${descriptor.role}/`) || !/^[A-Za-z0-9._-]+$/u.test(descriptor.sessionFile.slice(`/ticket/sessions/${descriptor.role}/`.length))) throw new RoleAttachmentError("role session file is not role-bound");
  const identityParts = descriptor.runnerCommand[2]!.split(":");
  if (identityParts[1] !== descriptor.sandboxName || identityParts[2] !== descriptor.sandboxId || identityParts[3] !== descriptor.bootId || identityParts[4] !== descriptor.allocationId || identityParts[5] !== String(descriptor.generation)) throw new RoleAttachmentError("role attachment runner identity is not bound to the descriptor");
}
function safeIdentity(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 512 && /^[A-Za-z0-9][A-Za-z0-9._-]{0,511}$/u.test(value); }
function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T { if (!value || typeof value !== "object" || seen.has(value as object)) return value; seen.add(value as object); for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child, seen); return Object.freeze(value); }

export class SandboxRoleAttachmentRegistry {
  readonly #descriptors = new Map<string, RoleAttachmentDescriptor>();
  publish(descriptor: RoleAttachmentDescriptor): RoleAttachmentDescriptor {
    assertAttachmentDescriptor(descriptor);
    const key = `${descriptor.runId}:${descriptor.role}`; const existing = this.#descriptors.get(key);
    if (existing && canonicalJson(existing) !== canonicalJson(descriptor)) throw new RoleAttachmentError("role attachment was substituted");
    const immutable = deepFreeze({ ...descriptor, runnerCommand: [...descriptor.runnerCommand] });
    this.#descriptors.set(key, immutable); return immutable;
  }
  get(runId: string, role: Role): RoleAttachmentDescriptor {
    assertSandboxRunId(runId); if (!ROLES.includes(role)) throw new RoleAttachmentError("role attachment role is not allowlisted"); const value = this.#descriptors.get(`${runId}:${role}`); if (!value) throw new RoleAttachmentError("role attachment is not published"); return value;
  }
  values(runId: string): readonly RoleAttachmentDescriptor[] { assertSandboxRunId(runId); return Object.freeze([...this.#descriptors.entries()].filter(([key]) => key.startsWith(`${runId}:`)).map(([, value]) => value)); }
}
