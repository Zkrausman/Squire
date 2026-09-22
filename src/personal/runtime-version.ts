/** Pure eligibility check: production supports stable Node.js 24 only. */
export function isSupportedNodeVersion(version: string): boolean {
  return /^v?24\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u.test(version);
}

export function unsupportedRuntimeMessage(version: string): string {
  // JSON quoting prevents injected/malformed versions from writing terminal controls.
  return `Squire requires Node.js 24 (>=24 <25); found ${JSON.stringify(version)}. Install Node.js 24 and retry. Node 22 is build/test bootstrap compatibility only.`;
}
