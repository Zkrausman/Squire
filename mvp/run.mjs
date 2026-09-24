#!/usr/bin/env node
/** One-ticket, fail-closed delivery. No model-produced report is an authority. */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePi, reviewPassed, exactHeadPassed } from './gates.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const runId = `mvp-${randomBytes(6).toString('hex')}`;
const sha = s => typeof s === 'string' && /^[a-f0-9]{40}$/.test(s);
const branchName = s => typeof s === 'string' && /^squire\/trial-[a-z0-9][a-z0-9-]{2,60}$/.test(s);
const slug = s => typeof s === 'string' && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(s);
const fail = m => { throw Error(m); };
let state;
async function persist() {
  const p = path.join(state.directory, 'state.json');
  const temp = `${p}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(temp, JSON.stringify(state, null, 2) + '\n', {flag:'wx', mode:0o600});
  await rename(temp, p);
}
async function stage(name, data = {}) {
  state.phase = name;
  Object.assign(state, data);
  state.events.push({at:new Date().toISOString(), phase:name});
  await persist();
}
async function command(program, args, opts = {}) {
  const {cwd, timeoutMs = 120000, output = null, env = process.env, input = null, allowFailure = false} = opts;
  const child = spawn(program, args, {cwd,env,stdio:['pipe','pipe','pipe'],windowsHide:true});
  if (input) child.stdin.end(input); else child.stdin.end();
  const limit = output ? 64*1024*1024 : 256*1024;
  let stdout=[],stderr=[],bytes=0;
  const timer = setTimeout(() => child.kill(), timeoutMs);
  let code;
  try {
    code = await new Promise((resolve,reject) => {
      child.stdout.on('data', b => {bytes+=b.length; if(bytes<=limit)stdout.push(b); else child.kill();});
      child.stderr.on('data', b => {bytes+=b.length; if(bytes<=limit)stderr.push(b); else child.kill();});
      child.on('error',reject); child.on('close',resolve);
    });
  } finally {clearTimeout(timer);}
  const out=Buffer.concat(stdout), err=Buffer.concat(stderr);
  if (output) {await writeFile(output,out,{flag:'wx',mode:0o600}); await writeFile(output+'.stderr',err,{flag:'wx',mode:0o600});}
  if (bytes>limit) fail(`${program} output exceeds bound`);
  if (code!==0 && !allowFailure) fail(`${program} exited ${code}: ${err.toString('utf8').slice(0,500) || out.toString('utf8').slice(0,500)}`);
  return {code, stdout:out.toString('utf8'), stderr:err.toString('utf8')};
}
const git = (repo,args,opts={}) => command('git',['-C',repo,'-c','core.hooksPath=/dev/null',...args],opts);
const sbx = (args,opts={}) => command('sbx',args,opts);
async function sandboxSh(sandbox,script,opts={}) {
  return sbx(['exec','-w','/ticket/workspace',sandbox,'sh','-lc',script],opts);
}
async function piRun({sandbox,prompt,mode,model,dir,timeoutMs}) {
  const args=['--mode','json','--session-dir',dir,'--provider','openai-codex','--model',model,
    '--thinking','medium','--no-extensions','--no-skills','--no-prompt-templates','--no-themes','--no-context-files','--no-approve'];
  if(mode==='implement') args.push('--no-builtin-tools','--extension',path.join(here,'sandbox-tool.mjs'));
  else args.push('--no-tools');
  args.push(prompt);
  const file=path.join(state.directory,`pi-${mode}.jsonl`);
  const cli=process.env.PI_CLI_PATH || path.join(path.dirname(process.execPath),'node_modules','@earendil-works','pi-coding-agent','dist','cli.js');
  if(!existsSync(cli)) fail('Current Pi CLI not found; set trusted PI_CLI_PATH');
  const result=await command(process.execPath,[cli,...args],{cwd:here,env:{...process.env,SQUIRE_SANDBOX_NAME:sandbox},timeoutMs,output:file});
  return parsePi(result.stdout);
}
async function main() {
  if(process.argv.length!==3) fail('Usage: node mvp/run.mjs <trusted-config.json>');
  const config=JSON.parse(await readFile(path.resolve(process.argv[2]),'utf8'));
  const {sourceRepo,baseSha,repository,branch,baseBranch,ticketFile,tests,requiredChecks,model,reviewModel,resultRoot,title}=config;
  if(!sha(baseSha)||!slug(repository)||!branchName(branch)||!Array.isArray(tests)||!tests.length||!tests.every(x=>typeof x==='string'&&x.length<300)||!Array.isArray(requiredChecks)||!requiredChecks.length||!requiredChecks.every(x=>typeof x==='string')||typeof title!=='string'||title.length>150||!/^[-.a-zA-Z0-9]+$/.test(baseBranch)||!/^gpt-[a-z0-9.-]+$/.test(model)||!/^gpt-[a-z0-9.-]+$/.test(reviewModel)) fail('Invalid trusted run config');
  const source=path.resolve(sourceRepo),root=path.resolve(resultRoot),ticket=path.resolve(ticketFile);
  if(!existsSync(ticket)||!existsSync(source)) fail('Missing source or ticket');
  const contract=await readFile(ticket,'utf8');
  if(contract.length===0 || contract.length>16000) fail('Ticket exceeds independent review bound');
  state={runId,directory:path.join(root,runId),phase:'starting',baseSha,branch,repository,events:[],startedAt:new Date().toISOString()};
  await mkdir(state.directory,{recursive:false,mode:0o700});
  await stage('preflight');
  const head=(await git(source,['rev-parse','HEAD'])).stdout.trim();
  if(head!==baseSha) fail('Source HEAD differs from pinned base');
  if((await git(source,['status','--porcelain'])).stdout.trim()) fail('Source checkout dirty');
  const bridge=path.join(state.directory,'bridge');await mkdir(bridge,{mode:0o700});
  const bundle=path.join(bridge,'source.bundle');
  await git(source,['bundle','create',bundle,'HEAD'],{timeoutMs:180000});
  const sandbox=runId;
  await stage('sandbox',{sandbox});
  await sbx(['create','--name',sandbox,'shell',bridge],{timeoutMs:180000,output:path.join(state.directory,'sandbox-create.log')});
  await sbx(['cp',bundle,`${sandbox}:/tmp/source.bundle`],{timeoutMs:90000});
  await sbx(['exec','-u','root',sandbox,'sh','-lc','mkdir -p /ticket && chown agent:agent /ticket'],{timeoutMs:60000});
  await sbx(['exec',sandbox,'sh','-lc',`git clone /tmp/source.bundle /ticket/workspace && git -C /ticket/workspace checkout -b '${branch}' '${baseSha}' && git -C /ticket/workspace config user.name Squire && git -C /ticket/workspace config user.email squire@localhost`],{timeoutMs:120000});
  await sbx(['cp',ticket,`${sandbox}:/ticket/ticket.md`],{timeoutMs:60000});
  await stage('implement');
  const implement=await piRun({sandbox,mode:'implement',model,dir:path.join(state.directory,'implement-session'),timeoutMs:30*60*1000,
    prompt:`You are implementing one bounded ticket in an isolated Linux clone at /ticket/workspace. Your only tool is sandbox_exec; every command runs inside that sandbox, not on the host. Read /ticket/ticket.md and repository AGENTS.md, inspect source, implement the contract with focused tests. Do not publish, merge, use credentials, alter unrelated files or run a queue. Do not return JSON or a special report. Finish when the worktree is ready; the host will freeze changes and independently test/review it.`});
  state.implementUsage=implement.usage;await persist();
  await stage('freeze');
  const before=(await sandboxSh(sandbox,'git rev-parse HEAD')).stdout.trim();
  if(before!==baseSha) {
    await sandboxSh(sandbox,`git merge-base --is-ancestor '${baseSha}' HEAD`);
  }
  const dirty=(await sandboxSh(sandbox,'git status --porcelain')).stdout.trim();
  if(dirty) {
    await sandboxSh(sandbox,'git add -A && git diff --cached --check && git commit -m "Implement scoped ticket"',{timeoutMs:90000});
  }
  const candidate=(await sandboxSh(sandbox,'git rev-parse HEAD')).stdout.trim();
  if(!sha(candidate)||candidate===baseSha) fail('No committed candidate');
  await sandboxSh(sandbox,`git merge-base --is-ancestor '${baseSha}' HEAD && test -z "$(git status --porcelain)"`);
  state.candidate=candidate;await persist();
  await sandboxSh(sandbox,'git bundle create /ticket/candidate.bundle HEAD',{timeoutMs:120000});
  const candidateBundle=path.join(state.directory,'candidate.bundle');
  await sbx(['cp',`${sandbox}:/ticket/candidate.bundle`,candidateBundle],{timeoutMs:120000});
  const hostRepo=path.join(state.directory,'candidate');
  await command('git',['clone','--no-hardlinks','--no-checkout',source,hostRepo],{timeoutMs:180000});
  await git(hostRepo,['fetch',candidateBundle,'HEAD'],{timeoutMs:120000});
  await git(hostRepo,['checkout','-b',branch,candidate]);
  if((await git(hostRepo,['rev-parse','HEAD'])).stdout.trim()!==candidate) fail('Bundle candidate changed');
  if((await git(hostRepo,['status','--porcelain'])).stdout.trim()) fail('Imported candidate dirty');
  await stage('tests',{hostRepo});
  for(let i=0;i<tests.length;i++){
    // Repository-controlled code runs only inside the credential-free sandbox.
    await sandboxSh(sandbox,tests[i],{timeoutMs:5*60*1000,output:path.join(state.directory,`test-${i}.log`)});
    if((await sandboxSh(sandbox,'git rev-parse HEAD')).stdout.trim()!==candidate || (await sandboxSh(sandbox,'git status --porcelain')).stdout.trim()) fail('Test mutated candidate');
    if((await git(hostRepo,['rev-parse','HEAD'])).stdout.trim()!==candidate || (await git(hostRepo,['status','--porcelain'])).stdout.trim()) fail('Imported candidate mutated');
  }
  const diff=(await git(hostRepo,['show','--format=fuller','--no-ext-diff','--no-textconv','--stat',candidate])).stdout;
  const patch=(await git(hostRepo,['diff','--no-ext-diff','--no-textconv',`${baseSha}..${candidate}`],{timeoutMs:60000})).stdout;
  if(Buffer.byteLength(patch)>100000) fail('Review diff exceeds bound');
  await stage('review');
  // Never follow a repository-controlled symlink on the credentialed host.
  const agents=(await sandboxSh(sandbox,'if test -f AGENTS.md; then head -c 10000 AGENTS.md; fi')).stdout || '(none)';
  const review=await piRun({sandbox,mode:'review',model:reviewModel,dir:path.join(state.directory,'review-session'),timeoutMs:10*60*1000,
    prompt:`You are an independent fresh read-only reviewer. No tools are available. Review against the contract and pinned base. Consider logic, regression tests, scope and unsafe side effects. Do not rely on implementer claims. Begin the final answer with PASS on its own line ONLY if no blocking issue; otherwise begin BLOCK and give concrete findings.\n\nTICKET:\n${contract}\n\nREPOSITORY INSTRUCTIONS:\n${agents}\n\nCOMMIT:\n${diff.slice(0,6000)}\n\nPATCH:\n${patch}`});
  state.reviewUsage=review.usage;
  await writeFile(path.join(state.directory,'review.txt'),review.text,{flag:'wx',mode:0o600});
  await persist();
  if(!reviewPassed(review.text)) fail('Independent review did not pass; candidate preserved');
  if((await git(hostRepo,['rev-parse','HEAD'])).stdout.trim()!==candidate) fail('Candidate moved after review');
  if(config.dryRun===true){
    await stage('validated-local',{completedAt:new Date().toISOString()});
    console.log(JSON.stringify({runId,phase:state.phase,candidate,recordedModelCost:implement.usage.cost+review.usage.cost}));
    return;
  }
  await stage('publish');
  await git(hostRepo,['remote','set-url','origin',`https://github.com/${repository}.git`]);
  await git(hostRepo,['push','-u','origin',`HEAD:refs/heads/${branch}`],{timeoutMs:180000});
  const body=path.join(state.directory,'pr-body.md');
  await writeFile(body,`## Summary\nOne-ticket minimal Squire MVP: ${title}\n\n## Provenance and gates\nPinned base: \`${baseSha}\`. Frozen candidate: \`${candidate}\`. Fresh independent read-only review PASS; configured isolated Linux tests passed. Windows validation requires exact-head hosted CI. This PR remains unmerged during trial. Model text was never used as a publication credential or test authority.\n`,{flag:'wx',mode:0o600});
  const pr=(await command('gh',['pr','create','--repo',repository,'--base',baseBranch,'--head',branch,'--title',title,'--body-file',body],{timeoutMs:60000})).stdout.trim();
  if(!new RegExp(`^https://github\\.com/${repository.replace('/','\\/')}/pull/[0-9]+$`).test(pr)) fail('Publication returned unexpected PR URL');
  state.prUrl=pr;await persist();
  await stage('ci');
  await command('gh',['pr','checks',pr,'--repo',repository,'--watch','--interval','15'],{timeoutMs:20*60*1000,output:path.join(state.directory,'ci-watch.log')});
  const info=JSON.parse((await command('gh',['pr','view',pr,'--repo',repository,'--json','state,headRefOid,baseRefName'])).stdout);
  const checks=JSON.parse((await command('gh',['pr','checks',pr,'--repo',repository,'--json','name,bucket,state'])).stdout);
  const checkRuns=JSON.parse((await command('gh',['api','-X','GET',`repos/${repository}/commits/${candidate}/check-runs?per_page=100`],{timeoutMs:60000})).stdout).check_runs;
  const finalInfo=JSON.parse((await command('gh',['pr','view',pr,'--repo',repository,'--json','state,headRefOid,baseRefName'])).stdout);
  if(!exactHeadPassed({pr:info,expectedHead:candidate,expectedBase:baseBranch,checks,checkRuns,required:requiredChecks}) || !exactHeadPassed({pr:finalInfo,expectedHead:candidate,expectedBase:baseBranch,checks,checkRuns,required:requiredChecks})) fail('Exact-head hosted CI gate failed or PR moved');
  await stage('passed',{completedAt:new Date().toISOString(),checks:requiredChecks});
  console.log(JSON.stringify({runId,phase:state.phase,prUrl:pr,candidate,recordedModelCost:implement.usage.cost+review.usage.cost}));
}
try {await main()} catch(error) {
  if(state){state.phase='failed';state.error=String(error?.message||error).slice(0,1000);state.completedAt=new Date().toISOString();state.events.push({at:state.completedAt,phase:'failed'});await persist().catch(()=>{});console.error(JSON.stringify({runId,phase:'failed',state:state.directory,reason:state.error}));}
  else console.error(String(error));
  process.exitCode=1;
} finally {
  // Stop, never delete: source, sessions, bundles and failed candidates stay inspectable.
  if(state?.sandbox) await sbx(['stop',state.sandbox],{timeoutMs:60000,allowFailure:true}).catch(()=>{});
}
