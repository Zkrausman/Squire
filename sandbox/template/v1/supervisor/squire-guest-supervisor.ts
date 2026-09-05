/* Squire guest supervisor v1 (template source).
 * This file is a build input only. The release builder records its exact
 * digest and refuses promotion until the external harness proves the running
 * helper is this byte identity. The runtime API is intentionally length-
 * prefixed and allowlisted; it never opens a listener or evaluates shell text.
 */
export const RELEASE_STATE = "blocked-until-external-conformance" as const;
export const CONTROLLER_UID = 1000 as const;
export const AGENT_UID = 1001 as const;
export const ALLOWED_OPERATIONS = ["attest", "verify-paths", "import", "export", "canary", "spawn-process", "pi-rpc", "signal-process", "reap-process", "workflow-store"] as const;

export function rejectAmbientExecution(): never {
  throw new Error("template supervisor source is not a directly executable release");
}
