/*
 * Squire guest supervisor v1 source identity.
 *
 * The production image carries the audited, dependency-free JavaScript guest
 * worker and fixed root supervisor bundles at runtime/squirectl.mjs and
 * runtime/squire-supervisor.mjs. This source file remains in the build
 * manifest so the release binds the design-time identity to both shipped
 * helpers; neither is executed through a shell or exposed as a role command.
 */
export const RELEASE_STATE = "buildable-awaiting-external-conformance" as const;
export const RUNTIME_BUNDLE = "runtime/squirectl.mjs" as const;
export const ROLE_BROKER_BUNDLE = "runtime/squire-supervisor.mjs" as const;
export const CONTROLLER_UID = 1000 as const;
export const AGENT_UID = 1001 as const;
export const ALLOWED_OPERATIONS = ["attest", "verify-paths", "import", "export", "canary", "spawn-process", "pi-rpc", "signal-process", "reap-process", "workflow-store"] as const;
export const PROTOCOL = "length-prefixed-canonical-json-v1" as const;
export const ROLE_BROKER_SOCKET = "/ticket/control/supervisor.sock" as const;
