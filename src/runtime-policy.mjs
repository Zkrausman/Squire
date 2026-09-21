/** Squire application policy, independent of dependency/action implementation runtimes. */
export const SUPPORTED_NODE_RANGE = ">=24 <25";

/** @param {string} version */
export function nodeRuntimeDiagnostic(version = process.versions.node) {
  if (/^v?24\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u.test(version)) return undefined;
  return `Unsupported Node.js version ${JSON.stringify(version)}. Squire requires Node.js 24 (${SUPPORTED_NODE_RANGE}). Install Node.js 24, select it in PATH, then rerun npm ci and npm run build before starting Squire.`;
}

/** @param {string} version */
export function assertSupportedNode(version = process.versions.node) {
  const diagnostic = nodeRuntimeDiagnostic(version);
  if (diagnostic) throw new Error(diagnostic);
}
