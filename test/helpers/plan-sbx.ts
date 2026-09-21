import { piEvents } from "./pi-json.js";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

/** Executable transport double used across a real private supervisor fork. */
export async function createPlanSbx(root: string, record: string): Promise<string> {
  const bin = path.join(root, "bin");
  await mkdir(bin, { recursive: true });
  await writeFile(path.join(bin, "package.json"), JSON.stringify({ type: "commonjs" }));
  const executable = path.join(bin, process.platform === "win32" ? "sbx.exe" : "sbx");
  const script = process.platform === "win32" ? path.join(bin, "plan-sbx.cjs") : executable;
  if (process.platform === "win32") {
    await copyFile(path.resolve("build/Release/windows_plan_sbx.exe"), executable);
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
else if (a.includes('node')) {
  const c = JSON.parse(fs.readFileSync(mapped(a.at(-1)), 'utf8'));
  const inputPath = c.args.at(-1).match(/from (.+)\\. Treat/)[1];
  const input = JSON.parse(fs.readFileSync(mapped(inputPath), 'utf8'));
  const prompt = c.args[c.args.indexOf('--system-prompt')+1];
  fs.appendFileSync(record, JSON.stringify({phase: input.subphase, prompt, digest: input.launchDigest, promptDigest: input.systemPromptDigest, args: c.args, data: input, stagingPath: fs.readFileSync(mapped(inputPath) + '.source', 'utf8'), guardStagingPath: fs.readFileSync(mapped(a.at(-1)) + '.source', 'utf8'), supervisorPid, envKeys: Object.keys(process.env)})+'\\n');
  const artifact = input.subphase === 'requirements' ? { version:1,inputHead:input.expectedHead,problem:'deliver change',acceptanceCriteria:['verified'],nonGoals:[],assumptions:[],dependencies:[],openQuestions:[],readiness:'ready' } : {version:1,inputHead:input.expectedHead,requirementsDigest:input.requirements.digest,steps:['implement'],affectedComponents:['src'],tests:['npm test'],risks:[],exactHeadEvidence:{head:input.expectedHead,observations:['inspected repository']},projectWiki:{status:'not_required',reason:'fixture adds no durable knowledge'}};
  process.stdout.write(piEvents(JSON.stringify(artifact), input.sessionId, input.profile).map(e => JSON.stringify(e)).join('\\n')+'\\n');
} else if (a.at(-1).includes('rev-parse HEAD')) process.stdout.write('a'.repeat(40)+'\\n');
`, { mode: 0o700 });
  return executable;
}
