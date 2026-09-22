import { piEvents } from "./pi-json.js";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

/** Executable transport double for native argv and handle probes. */
export async function createPhaseSbx(root: string, record: string): Promise<string> {
  const bin = path.join(root, "bin");
  await mkdir(bin, { recursive: true });
  await writeFile(path.join(bin, "package.json"), JSON.stringify({ type: "commonjs" }));
  const executable = path.join(bin, process.platform === "win32" ? "sbx.exe" : "sbx");
  const script = process.platform === "win32" ? path.join(bin, "phase-sbx.cjs") : executable;
  if (process.platform === "win32") {
    await copyFile(path.resolve("build/Release/windows_phase_sbx.exe"), executable);
    await writeFile(path.join(bin, "node-path.utf16"), Buffer.from(process.execPath, "utf16le"));
  }
  await writeFile(script, `#!/usr/bin/env node
const fs = require('node:fs');
const piEvents = ${piEvents.toString()};
const path = require('node:path');
const root = ${JSON.stringify(root)};
const record = ${JSON.stringify(record)};
const windowsShim = process.platform === 'win32';
const supervisorPid = windowsShim ? Number(process.argv[2].replace('--shim-parent-pid=', '')) : process.ppid;
if (windowsShim && !Number.isSafeInteger(supervisorPid)) throw new Error('missing shim parent identity');
const a = process.argv.slice(windowsShim ? 3 : 2);
if (a[0] === '--argv-probe') { process.stdout.write(JSON.stringify(a.slice(1))); process.stderr.write('shim-stderr'); process.exit(17); }
const native = process.platform === 'win32' ? require(${JSON.stringify(path.resolve("build/Release/windows_launch.node"))}) : undefined;
const mapped = p => path.join(root, Buffer.from(p).toString('hex'));
if (a[0] === 'cp') {
  if (native) native.read(a[1], ''); // Native ACL/reparse verification at actual captured-byte consumption.
  const target = mapped(a[2].slice(a[2].indexOf(':')+1));
  fs.copyFileSync(a[1], target); fs.writeFileSync(target + '.source', a[1]);
}
`, { mode: 0o700 });
  return executable;
}
