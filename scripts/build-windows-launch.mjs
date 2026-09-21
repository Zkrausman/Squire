import { assertSupportedNode } from "../src/node-runtime-policy.mjs";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
assertSupportedNode();
// Linux builds only the test exit observer, never the Windows trust boundary.
if (process.platform === "win32" || process.platform === "linux") {
  const require = createRequire(import.meta.url);
  const result = spawnSync(process.execPath, [require.resolve("node-gyp/bin/node-gyp.js"), "rebuild"], { stdio: "inherit", shell: false });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}
