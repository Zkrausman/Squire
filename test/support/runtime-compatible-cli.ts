// Test-only imported launcher. No environment variable or executable option can
// bypass the production guard. Node 24 tests use the real production entrypoint.
import { main as productionMain } from "../../src/personal/cli.js";
import { isSupportedNodeVersion } from "../../src/personal/runtime-version.js";
import { fileURLToPath, pathToFileURL } from "node:url";

const supported = isSupportedNodeVersion(process.versions.node);
export const cliPath = fileURLToPath(new URL(supported ? "../../src/personal/cli.js" : "./runtime-compatible-cli.js", import.meta.url));
export function main(argv: string[]): Promise<number> {
  return supported ? productionMain(argv) : productionMain(argv, { nodeVersion: "24.0.0", cliPath });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
