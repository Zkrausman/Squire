import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

/** Executable transport double used across a real private supervisor fork. */
export async function createPlanSbx(root: string, record: string): Promise<string> {
  const bin = path.join(root, "bin");
  await mkdir(bin, { recursive: true });
  await writeFile(path.join(bin, "package.json"), JSON.stringify({ type: "commonjs" }));
  const executable = path.join(bin, "sbx");
  await writeFile(executable, `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const root = ${JSON.stringify(root)};
const record = ${JSON.stringify(record)};
const a = process.argv.slice(2);
const mapped = p => path.join(root, Buffer.from(p).toString('hex'));
if (a[0] === 'cp') { fs.copyFileSync(a[1], mapped(a[2].slice(a[2].indexOf(':')+1))); }
else if (a.includes('node')) {
  const c = JSON.parse(fs.readFileSync(mapped(a.at(-1)), 'utf8'));
  const inputPath = c.args.at(-1).match(/from (.+)\\. Treat/)[1];
  const input = JSON.parse(fs.readFileSync(mapped(inputPath), 'utf8'));
  const prompt = c.args[c.args.indexOf('--system-prompt')+1];
  fs.appendFileSync(record, JSON.stringify({phase: input.subphase, prompt, digest: input.launchDigest, promptDigest: input.systemPromptDigest, args: c.args, data: input, supervisorPid: process.ppid, envKeys: Object.keys(process.env)})+'\\n');
  const artifact = input.subphase === 'requirements' ? { version:1,inputHead:input.expectedHead,problem:'deliver change',acceptanceCriteria:['verified'],nonGoals:[],assumptions:[],dependencies:[],openQuestions:[],readiness:'ready' } : {version:1,inputHead:input.expectedHead,requirementsDigest:input.requirements.digest,steps:['implement'],affectedComponents:['src'],tests:['npm test'],risks:[],exactHeadEvidence:{head:input.expectedHead,observations:['inspected repository']},projectWiki:{status:'not_required',reason:'fixture adds no durable knowledge'}};
  process.stdout.write(JSON.stringify(artifact));
} else if (a.at(-1).includes('rev-parse HEAD')) process.stdout.write('a'.repeat(40)+'\\n');
`, { mode: 0o700 });
  return executable;
}
