/** Named AIDEV-223 process identity port. The implementation is kept next
 * to the sandbox Pi adapter so identity parsing cannot be bypassed by a role. */
export { SandboxProcessIdentityResolver, SandboxPiProcessError } from "./pi-process-factory.js";
export type { SandboxPiProcessFactoryOptions } from "./pi-process-factory.js";
