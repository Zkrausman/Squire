/** Squire application runtime; dependency/action implementation runtimes are separate. */
export const NODE_RUNTIME_RANGE = ">=24 <25";

/** @param {string} [version] Injectable for tests, never read from configuration or env. */
export function assertSupportedNode(version = process.versions.node) {
  if (typeof version === "string" && version.length <= 64 && /^24\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(version)) return;
  // Bound and escape untrusted diagnostics, including terminal control characters.
  const detected = typeof version === "string"
    ? version.slice(0, 64).replace(/[^A-Za-z0-9.+_-]/gu, "?") + (version.length > 64 ? "..." : "")
    : "unknown";
  throw new Error(`Unsupported Node.js ${detected || "(empty)"}; Squire requires ${NODE_RUNTIME_RANGE}. Install/use Node.js 24 on the host and sandbox template, then reinstall with npm ci --engine-strict and rebuild.`);
}

// Use the same dependency-free policy in any target repository's sandbox,
// before installing its runtime or copying model credentials. No worktree code
// or host path is needed to perform this controller-owned preflight.
export const NODE_RUNTIME_PREFLIGHT = `const NODE_RUNTIME_RANGE = ${JSON.stringify(NODE_RUNTIME_RANGE)}; (${assertSupportedNode.toString()})();`;
