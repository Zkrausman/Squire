import {generationEnvironment} from './bounded-codegen-plan.mjs';
import {createCodegenStreamCollector} from './limited-stream-collector.mjs';
import {stageGeneratedSource} from './limited-source-staging.mjs';
import {spawn} from 'node:child_process';
import * as fs from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {closed, fail} from './job-spec.mjs';
import {AGY_BYTE_LIMITS, AGY_CHILD_ENV_DELETIONS, validateAgyPrompt} from './agy-profile.mjs';
import {runForeground} from './internal/limited-core.mjs';

const MODEL = 'gemini-3.8-flash-high', EXECUTABLE = '/home/zack/.local/bin/agy';
const usedJobs = new Set(), usedScopes = new Set(); // Process-local nonreuse only; not durable custody.
export function admitLimitedAgyTask(specification, bounds = AGY_BYTE_LIMITS) {
  closed(specification, ['job_id', 'task_scope', 'requested_model', 'effort', 'max_wall_clock_sec', 'prompt_bytes'], [], 'limited_spec');
  const s = specification;
  if (typeof s.job_id !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(s.job_id) ||
      typeof s.task_scope !== 'string' || !s.task_scope.startsWith('/') || resolve(s.task_scope) !== s.task_scope || s.task_scope === '/' ||
      s.requested_model !== MODEL || s.effort !== 'high' || s.max_wall_clock_sec !== 120 || !validateAgyPrompt(s.prompt_bytes, bounds).valid) fail('limited_admission');
  return Object.freeze({...s, prompt_bytes: new Uint8Array(s.prompt_bytes)});
}
function options(value, probe = false) {
  closed(value, ['clock', 'shutdown', ...(probe ? ['task_scope'] : ['output_path'])], ['abortSignal'], 'limited_options');
  closed(value.clock, ['now', 'schedule'], [], 'limited_clock');
  if (typeof value.clock.now !== 'function' || typeof value.clock.schedule !== 'function') fail('limited_clock');
  closed(value.shutdown, ['term_grace_ms', 'kill_grace_ms', 'poll_interval_ms', 'stream_drain_timeout_ms', 'persistence_timeout_ms'], [], 'limited_shutdown');
  if (Object.values(value.shutdown).some(v => !Number.isSafeInteger(v) || v <= 0 || v > 10000)) fail('limited_shutdown');
  if (value.abortSignal !== undefined && !(value.abortSignal instanceof AbortSignal)) fail('limited_abort');
  return {...value, clock: {now: value.clock.now.bind(value.clock), schedule: value.clock.schedule.bind(value.clock)}, shutdown: {...value.shutdown}};
}
function childEnvironment(scope) {
  const environment = {...process.env, TMPDIR: join(scope, '.tmp')};
  for (const key of AGY_CHILD_ENV_DELETIONS) delete environment[key];
  return environment;
}
function claim(job, scope) {
  if (usedJobs.has(job) || usedScopes.has(scope)) fail('limited_nonreuse');
  usedJobs.add(job); usedScopes.add(scope);
}
async function directory(path) {const st = await fs.lstat(path); if (!st.isDirectory() || st.isSymbolicLink()) fail('limited_directory');}
export async function runLimitedAgyTask(specification, runtimeOptions) {
  const spec = admitLimitedAgyTask(specification), opts = options(runtimeOptions);
  const run = join(spec.task_scope, 'output', 'run-' + spec.job_id), expected = join(run, 'squire-limited-task-output.json');
  if (opts.output_path !== expected) fail('limited_output_path');
  claim(spec.job_id, run);
  await directory(spec.task_scope);
  // Owned output parent may already exist; the run directory itself must be new.
  try {await fs.mkdir(join(spec.task_scope, 'output'), {mode: 0o700});} catch (e) {if (e.code !== 'EEXIST') throw e;}
  await directory(join(spec.task_scope, 'output'));
  await fs.mkdir(run, {mode: 0o700}); // EEXIST is a consumed, fail-closed attempt.
  try {await fs.mkdir(join(spec.task_scope, '.tmp'), {mode: 0o700});} catch (e) {if (e.code !== 'EEXIST') throw e;}
  await directory(join(spec.task_scope, '.tmp'));
  const prompt = new TextDecoder('utf-8', {fatal: true}).decode(spec.prompt_bytes);
  const invocation = {executable: EXECUTABLE, args: ['--prompt', prompt, '--output-format', 'json', '--model', MODEL,
    '--effort', 'high', '--print-timeout', '1m', '--sandbox', '--disable-slash-commands']};
  const persist = async (bytes, signal) => {
    const check = () => {if (signal.aborted) throw Error('PERSISTENCE_ABORTED');};
    check(); const stage = join(run, '.output-' + randomUUID());
    // Complete stage then atomic no-clobber publication. No durability/crash-recovery claim.
    const handle = await fs.open(stage, 'wx', 0o600);
    try {check(); await handle.writeFile(bytes); check();} finally {await handle.close();}
    check(); await fs.link(stage, expected); check();
    await fs.unlink(stage); check();
  };
  return runForeground({...spec, task_class: 'PUBLIC_INLINE_TEXT_SUMMARIZATION_FOREGROUND'}, invocation, opts,
    {clock: opts.clock, spawn, persist, environment: childEnvironment(spec.task_scope)});
}
export async function runInertTimeoutAcceptanceProbe(runtimeOptions) {
  const opts = options(runtimeOptions, true), scope = opts.task_scope;
  if (typeof scope !== 'string' || !scope.startsWith('/') || resolve(scope) !== scope || scope === '/') fail('probe_scope');
  const job_id = '4c2a8e1b-5d9f-4321-a76c-8e0f1b2c3d4e';
  claim(job_id, scope + '/limited-timeout-probe'); await directory(scope);
  return runForeground({job_id, task_scope: scope, requested_model: 'NONE', max_wall_clock_sec: 1, task_class: 'INERT_TIMEOUT_ACCEPTANCE_PROBE'},
    {executable: '/bin/sleep', args: ['30']}, opts,
    {clock: opts.clock, spawn, persist: () => {throw Error('NO_PROBE_PERSISTENCE');}, environment: childEnvironment(scope)});
}

// Q218 source-only seam. Required explicit ports: no native generation default.
export const admitBoundedCodegenTask = admitLimitedAgyTask;
export async function runBoundedCodegenTask(specification, runtimeOptions, ports) {
  const spec = admitBoundedCodegenTask(specification), opts = options(runtimeOptions);
  if (!ports || typeof ports.spawn !== 'function' || !ports.fs) fail('codegen_injected_ports_required');
  const run = join(spec.task_scope,'output','run-' + spec.job_id), expected = join(run,'workspace','src','summarizer.mjs');
  if(opts.output_path !== expected) fail('codegen_output_path');
  claim(spec.job_id,run);
  const fsPort = ports.fs;
  const scopeStat = await fsPort.lstat(spec.task_scope);
  if(!scopeStat.isDirectory() || scopeStat.isSymbolicLink()) fail('codegen_scope');
  try {await fsPort.mkdir(join(spec.task_scope,'output'),{mode:0o700});} catch(e) {if(e.code !== 'EEXIST') throw e;}
  const parent = await fsPort.lstat(join(spec.task_scope,'output'));
  if(!parent.isDirectory() || parent.isSymbolicLink()) fail('codegen_output_parent');
  await fsPort.mkdir(run,{mode:0o700}); // fresh, no recursive EEXIST acceptance
  try {await fsPort.mkdir(join(spec.task_scope,'.tmp'),{mode:0o700});} catch(e) {if(e.code!=='EEXIST')throw e;}
  const tmpStat=await fsPort.lstat(join(spec.task_scope,'.tmp'));
  if(!tmpStat.isDirectory()||tmpStat.isSymbolicLink())fail('codegen_tmp_directory');
  let witness = null;
  const persist = async (bytes,signal) => {witness = await stageGeneratedSource({run_root:run,source_bytes:bytes,signal},
    {fs:fsPort,clock:opts.clock,validateSyntax:ports.validateSyntax});};
  const prompt = new TextDecoder('utf-8',{fatal:true}).decode(spec.prompt_bytes);
  const result = await runForeground({...spec,task_class:'BOUNDED_CODEGEN_SUMMARIZER_V5'},
    {executable:EXECUTABLE,args:['--prompt',prompt,'--output-format','json','--model',MODEL,'--effort','high','--print-timeout','1m','--sandbox','--disable-slash-commands']},opts,
    {clock:opts.clock,spawn:ports.spawn,persist,environment:generationEnvironment(spec.task_scope,process.env),createCollector:createCodegenStreamCollector});
  return Object.freeze({...result,physical_source_witness:result.record.output_custody.persisted ? witness : null,runtime_admitted:false});
}
