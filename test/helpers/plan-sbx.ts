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
if (a.includes('node')) {
  const bytes=fs.readFileSync(0);const payload=JSON.parse(bytes);
  if (!payload.config) { fs.writeFileSync(mapped(a.at(-1)),bytes); process.exit(0); }
  if(require('node:crypto').createHash('sha256').update(bytes).digest('hex')!==a.at(-1))throw new Error('transport digest');
  const c=payload.config,input=JSON.parse(payload.data),prompt=payload.prompt;
  fs.appendFileSync(record, JSON.stringify({phase: input.subphase || input.phase || input.trusted.phase, correction: !!input.trusted, prompt, digest: input.launchDigest, promptDigest: input.systemPromptDigest, args: c.args, data: input, wireArgs:a, actualArgv:process.argv, actualCommandLine: windowsShim ? fs.readFileSync(path.join(root,'bin','command-line.utf16')).toString('utf16le') : null, environment:process.env, bytes:bytes.length, sha256:require('node:crypto').createHash('sha256').update(bytes).digest('hex'), transportId:payload.id, supervisorPid, envKeys: Object.keys(process.env)})+'\\n');
  let artifact = input.subphase === 'requirements' ? { version:1,inputHead:input.expectedHead,problem:'deliver change',acceptanceCriteria:['verified'],nonGoals:[],assumptions:[],dependencies:[],openQuestions:[],readiness:'ready' } : {version:1,inputHead:input.expectedHead,requirementsDigest:input.requirements?.digest,steps:['implement'],affectedComponents:['src'],tests:['npm test'],risks:[],exactHeadEvidence:{head:input.expectedHead,observations:['inspected repository']},projectWiki:{status:'not_required',reason:'fixture adds no durable knowledge'}};
  if (!input.subphase) {
    const phase=input.phase||input.trusted.phase;
    const details=phase==='plan'?{steps:['implement']}:phase==='implement'?{changes:['fixture'],projectWiki:{status:'not_required',reason:'fixture adds no durable knowledge'}}:phase==='review'?{findings:[]}:phase==='test'?{commands:[{command:'npm test',exitCode:0,summary:'passed'}]}:{lessons:['fixture'],followUps:[]};
    artifact={outputHead:input.expectedHead||input.trusted.inputHead,status:'passed',summary:'fixture passed',details};
  }
  process.stdout.write(JSON.stringify(artifact));
} else if (a.at(-1).includes('rev-parse HEAD')) process.stdout.write('a'.repeat(40)+'\\n');
`, { mode: 0o700 });
  return executable;
}
