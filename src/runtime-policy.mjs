// Plain JavaScript so installation can enforce the same policy before TypeScript
// or native compilation exists. TypeScript copies this module into dist/src.
export const SUPPORTED_NODE_RANGE = ">=24 <25";

/** @param {string} [version] */
export function assertSupportedNode(version = process.versions.node) {
  // Accept release versions only, not malformed strings or prerelease builds.
  if (/^v?24\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u.test(version)) return;
  throw new Error(`Unsupported Node.js version ${JSON.stringify(version)}; Squire requires ${SUPPORTED_NODE_RANGE} (Node.js 24 only). Install Node.js 24, ensure node and npm use it, then run npm ci --engine-strict and npm run build.`);
}
