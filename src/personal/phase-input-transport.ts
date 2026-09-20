import { randomUUID } from "node:crypto";
import path from "node:path";
import { mkdir } from "node:fs/promises";
import { createReportEvidence, reportHash, verifyReportEvidence, type ReportEvidence, type ReportEvidencePort } from "./report-evidence.js";
import { PhaseExecutionError } from "./execution-failure.js";
import { CommandExecutionError, type CommandPort, type CommandRequest } from "./command.js";
import type { PhaseInput } from "./types.js";
import { canonical } from "./launch-material.js";

export const MAX_TRANSPORT_BYTES = 64 * 1024 * 1024;
const CHUNK_BYTES = 1024 * 1024;
export interface TransportBinding {
  readonly runId: string; readonly phase: string; readonly subphase: string | null;
  readonly attempt: number; readonly producer: string; readonly expectedHead: string;
  readonly originalTicketBaseSha: string; readonly profileDigest: string;
}
export interface TransportReference {
  readonly version: 1; readonly id: string; readonly binding: TransportBinding;
  readonly byteLength: number; readonly sha256: string; readonly chunks: readonly ReportEvidence[];
}
export function transportBinding(input: PhaseInput, subphase: string | null = null, producer = "phase"): TransportBinding {
  return { runId: input.runId, phase: input.phase, subphase, attempt: input.attempt, producer,
    expectedHead: input.expectedHead, originalTicketBaseSha: input.originalTicketBaseSha,
    profileDigest: reportHash(Buffer.from(canonical(input.profile))) };
}
function closed(value: unknown, keys: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join() !== keys) throw new Error("shape");
}
function validateBinding(b: TransportBinding): void {
  closed(b, "attempt,expectedHead,originalTicketBaseSha,phase,producer,profileDigest,runId,subphase");
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(b.runId) || !["plan", "implement", "review", "test", "retro"].includes(b.phase) ||
    ![null, "requirements", "implementation-design"].includes(b.subphase) || (b.subphase !== null && b.phase !== "plan") ||
    !Number.isSafeInteger(b.attempt) || b.attempt < 1 || b.attempt > 1000000 || !/^[a-zA-Z0-9_-]{1,100}$/.test(b.producer) ||
    !/^[a-f0-9]{40}$/.test(b.expectedHead) || !/^[a-f0-9]{40}$/.test(b.originalTicketBaseSha) || !/^[a-f0-9]{64}$/.test(b.profileDigest)) throw new Error("binding");
}
export function transportFailure(binding?: TransportBinding, byteLength = 0, digest = "unavailable"): PhaseExecutionError {
  const phase = binding && ["plan", "implement", "review", "test", "retro"].includes(binding.phase) ? binding.phase : "unknown";
  const size = Number.isSafeInteger(byteLength) && byteLength >= 0 && byteLength <= MAX_TRANSPORT_BYTES ? byteLength : "over-capacity";
  const prefix = /^[a-f0-9]{64}$/.test(digest) ? digest.slice(0, 12) : "unavailable";
  return new PhaseExecutionError("infrastructure", `phase_transport: phase=${phase} protected-stdin schema=1 bytes=${size} digest=${prefix} validation=rejected; no model authorization; operator must correct transport capability/bindings and authorize a fresh attempt`);
}
/** The existing Linux fd-relative / Windows retained NTFS handle store, chunked
 * without changing the strict 2 MiB report-evidence specialization. Failed bytes
 * are retained; release closes leases, never deletes or rewrites evidence. */
export class PhaseInputTransport {
  readonly store: ReportEvidencePort;
  constructor(readonly root: string) { this.store = createReportEvidence(path.join(root, "phase-transport")); }
  async preflight(): Promise<void> {
    try {
      if (process.platform === "linux") await mkdir(this.root, { recursive: true, mode: 0o700 });
      await this.store.preflight?.();
    } catch { throw transportFailure(); }
  }
  async write(value: unknown, binding: TransportBinding): Promise<TransportReference> {
    let byteLength = 0, digest = "unavailable";
    try {
      validateBinding(binding);
      const envelope = { version: 1, id: randomUUID(), binding: structuredClone(binding), value };
      const bytes = Buffer.from(canonical(envelope));
      byteLength = bytes.length; digest = reportHash(bytes);
      if (!bytes.length || bytes.length > MAX_TRANSPORT_BYTES) throw new Error("capacity");
      await this.preflight();
      const chunks: ReportEvidence[] = [];
      for (let i = 0; i < bytes.length; i += CHUNK_BYTES) chunks.push(await this.store.write(bytes.subarray(i, i + CHUNK_BYTES)));
      const ref: TransportReference = { version: 1, id: envelope.id, binding: envelope.binding, byteLength: bytes.length, sha256: reportHash(bytes), chunks };
      // The immutable manifest is launch evidence even when spawn never occurs.
      await this.store.write(canonical(ref));
      return ref;
    } catch { throw transportFailure(binding, byteLength, digest); }
  }
  async read(ref: TransportReference, binding: TransportBinding): Promise<Buffer> {
    try {
      closed(ref, "binding,byteLength,chunks,id,sha256,version"); validateBinding(ref.binding); validateBinding(binding);
      if (ref.version !== 1 || !/^[a-f0-9-]{36}$/.test(ref.id) || canonical(ref.binding) !== canonical(binding) ||
        !Number.isSafeInteger(ref.byteLength) || ref.byteLength < 1 || ref.byteLength > MAX_TRANSPORT_BYTES || !/^[a-f0-9]{64}$/.test(ref.sha256) ||
        !Array.isArray(ref.chunks) || ref.chunks.length !== Math.ceil(ref.byteLength / CHUNK_BYTES) || new Set(ref.chunks.map(c => c.path)).size !== ref.chunks.length) throw new Error("reference");
      const bytes = Buffer.concat(await Promise.all(ref.chunks.map(c => verifyReportEvidence(this.store, c))));
      if (bytes.length !== ref.byteLength || reportHash(bytes) !== ref.sha256) throw new Error("digest");
      const envelope: unknown = JSON.parse(bytes.toString("utf8"));
      closed(envelope, "binding,id,value,version");
      if (envelope["version"] !== 1 || envelope["id"] !== ref.id || canonical(envelope["binding"]) !== canonical(binding)) throw new Error("envelope binding");
      return Buffer.from(canonical(envelope["value"]));
    } catch { throw transportFailure(binding, ref?.byteLength, ref?.sha256); }
  }
  async release(): Promise<void> { await this.store.release?.(); }
}

/** Conservative Windows UTF-16 quoting bound, shared on Linux. No payload env. */
export function checkTransportCommand(commands: CommandPort, request: CommandRequest): void {
  if (commands.byteInput !== true || !Buffer.isBuffer(request.stdin) || request.stdin.length > MAX_TRANSPORT_BYTES ||
    [request.command, ...request.args].some(s => typeof s !== "string" || s.includes("\0")) ||
    [request.command, ...request.args].reduce((n, s) => n + s.length * 2 + 3, 0) > 24000 ||
    Object.entries(request.env ?? {}).reduce((n, [k, v]) => n + k.length + (v?.length ?? 0) + 2, 0) > 24000) throw transportFailure();
}
export interface GuardConfig {
  readonly control?: string; readonly cwd: string; readonly uid: number; readonly gid: number;
  readonly deadline: number; readonly executable: string; readonly env: Record<string, string>;
  readonly args: readonly string[];
}
export function guardPayload(binding: TransportBinding, config: GuardConfig, prompt: string, data: string) {
  validateBinding(binding);
  return { version: 1, id: randomUUID(), binding, config, prompt, data,
    promptDigest: reportHash(Buffer.from(prompt)), dataDigest: reportHash(Buffer.from(data)),
    promptBytes: Buffer.byteLength(prompt), dataBytes: Buffer.byteLength(data) };
}

/** Fixed reviewed bootstrap, identical for both controller platforms. sbx exec
 * must pipe stdin (-i). Root publishes prompt bytes outside the writable repo;
 * Pi's supported --system-prompt FILE preserves system-layer precedence. */
export const PHASE_GUARD = `
const fs=require('node:fs'), crypto=require('node:crypto'), {spawn}=require('node:child_process');
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const fail=()=>{process.stderr.write('phase_transport: protected-stdin schema=1 validation=rejected; authorize fresh attempt after transport repair\\n');process.exitCode=78;};
const chunks=[];let size=0;
process.stdin.on('data',b=>{size+=b.length;if(size>67108864){fail();process.exit(78);}chunks.push(b);});
process.stdin.on('error',fail);
process.stdin.on('end',()=>{try{
 const bytes=Buffer.concat(chunks);if(hash(bytes)!==process.argv[1])throw 0;
 const p=JSON.parse(bytes), c=p.config, b=p.binding;
 if(Object.keys(p).sort().join()!=='binding,config,data,dataBytes,dataDigest,id,prompt,promptBytes,promptDigest,version'||p.version!==1||!/^[a-f0-9-]{36}$/.test(p.id))throw 0;
 if(Object.keys(b).sort().join()!=='attempt,expectedHead,originalTicketBaseSha,phase,producer,profileDigest,runId,subphase'||!/^[a-zA-Z0-9_-]{1,100}$/.test(b.runId)||!['plan','implement','review','test','retro'].includes(b.phase)||![null,'requirements','implementation-design'].includes(b.subphase)||!Number.isSafeInteger(b.attempt)||b.attempt<1||b.attempt>1000000||!/^[a-zA-Z0-9_-]{1,100}$/.test(b.producer)||(b.subphase!==null&&b.phase!=='plan')||!/^[a-f0-9]{40}$/.test(b.expectedHead)||!/^[a-f0-9]{40}$/.test(b.originalTicketBaseSha)||!/^[a-f0-9]{64}$/.test(b.profileDigest))throw 0;
 for(const name of ['prompt','data'])if(typeof p[name]!=='string'||Buffer.byteLength(p[name])!==p[name+'Bytes']||hash(p[name])!==p[name+'Digest'])throw 0;
 if(!Number.isInteger(c.uid)||c.uid<=0||!Number.isInteger(c.gid)||c.gid<=0||!Number.isFinite(c.deadline)||Date.now()>=c.deadline||!Array.isArray(c.args)||c.args.some(a=>typeof a!=='string'||a.includes('\\0'))||c.args.join(' ').length>8000||c.args.includes('--system-prompt'))throw 0;
 if(Object.keys(c).sort().join()!==('control' in c?'args,control,cwd,deadline,env,executable,gid,uid':'args,cwd,deadline,env,executable,gid,uid')||typeof c.cwd!=='string'||c.cwd.length>1024||typeof c.executable!=='string'||c.executable.length>1024)throw 0;
 const allowed=['PATH','HOME','TMPDIR','PI_CODING_AGENT_DIR','PI_OFFLINE','PI_TELEMETRY'];if(Object.keys(c.env).some(k=>!allowed.includes(k)||typeof c.env[k]!=='string'||c.env[k].includes('\\0'))||JSON.stringify(c.env).length>8000)throw 0;
 const d=JSON.parse(p.data),t=d.trusted||d;
 if(t.runId!==b.runId||t.phase!==b.phase||t.attempt!==b.attempt||(t.expectedHead||t.inputHead)!==b.expectedHead||t.originalTicketBaseSha!==b.originalTicketBaseSha||(d.subphase||null)!==b.subphase)throw 0;
 const canon=v=>v&&typeof v==='object'?(Array.isArray(v)?'['+v.map(canon).join(',')+']':'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canon(v[k])).join(',')+'}'):JSON.stringify(v);
 if(hash(canon(t.profile))!==b.profileDigest)throw 0;
 for(const k of ['provider','model','thinking'])if(c.args[c.args.indexOf('--'+k)+1]!==t.profile[k])throw 0;
 const root='/run/squire-input-'+p.id;
 fs.mkdirSync(root,{mode:0o755});
 const publish=(name,value)=>{const file=root+'/'+name;const fd=fs.openSync(file,fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_WRONLY|fs.constants.O_NOFOLLOW,0o444);fs.writeFileSync(fd,value);fs.fsyncSync(fd);const before=fs.fstatSync(fd);fs.closeSync(fd);const r=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);const s=fs.fstatSync(r),actual=fs.readFileSync(r),after=fs.fstatSync(r);fs.closeSync(r);const named=fs.lstatSync(file);if(s.uid!==0||s.nlink!==1||!s.isFile()||(s.mode&0o222)||s.ino!==before.ino||s.ino!==named.ino||s.size!==after.size||hash(actual)!==hash(value))throw 0;return file;};
 publish('envelope.json',bytes);const prompt=publish('system.txt',p.prompt);publish('input.json',p.data);
 let child,stopped=false,closed=false,killTimer;
 const done=()=>{if(c.control)fs.writeFileSync(c.control+'/done','closed',{flag:'wx'});};
 const stop=()=>{if(stopped)return;stopped=true;if(child&&child.pid&&!closed){try{process.kill(-child.pid,'SIGTERM');}catch{}killTimer=setTimeout(()=>{try{process.kill(-child.pid,'SIGKILL');}catch{}},2000);}};
 if(c.control&&fs.existsSync(c.control+'/cancel')){done();process.exitCode=1;return;}
 child=spawn(c.executable,[...c.args,'--system-prompt',prompt],{cwd:c.cwd,uid:c.uid,gid:c.gid,env:c.env,detached:true,stdio:['pipe','pipe','pipe']});
 child.stdin.on('error',()=>stop());child.stdin.end(p.data);
 child.stdout.pipe(process.stdout);child.stderr.pipe(process.stderr);
 process.stdout.on('error',()=>{child.stdout.unpipe(process.stdout);child.stdout.resume();stop();});process.stderr.on('error',()=>{child.stderr.unpipe(process.stderr);child.stderr.resume();stop();});
 const poll=setInterval(()=>{if(c.control&&fs.existsSync(c.control+'/cancel'))stop();},100),deadline=setTimeout(stop,Math.max(1,c.deadline-Date.now()));
 process.on('SIGTERM',stop);process.on('SIGINT',stop);process.on('SIGHUP',stop);
 child.on('error',()=>{stopped=true;});child.on('close',code=>{closed=true;clearInterval(poll);clearTimeout(deadline);clearTimeout(killTimer);done();process.exitCode=stopped?1:(code===0?0:1);});
}catch{fail();}});
`;
export async function launchProtected(commands: CommandPort, store: PhaseInputTransport, binding: TransportBinding,
  payload: ReturnType<typeof guardPayload>, sbx: string, sandbox: string, env: NodeJS.ProcessEnv, timeoutMs: number, signal?: AbortSignal, prepare?: () => Promise<void>) {
  let dispatched = false;
  let observed: Buffer | undefined;
  try {
    if (payload.config.control && !/^\/run\/squire-(?:control-[a-f0-9-]{36}|plan-[a-f0-9-]{36}\/control\/(?:requirements|implementation-design))$/.test(payload.config.control)) throw transportFailure(binding);
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(sandbox)) throw transportFailure();
    // Capability/capacity gate precedes any spawn, including the evidence write.
    if (payload.version !== 1 || canonical(payload.binding) !== canonical(binding) ||
      reportHash(Buffer.from(payload.prompt)) !== payload.promptDigest || Buffer.byteLength(payload.prompt) !== payload.promptBytes ||
      reportHash(Buffer.from(payload.data)) !== payload.dataDigest || Buffer.byteLength(payload.data) !== payload.dataBytes ||
      payload.config.args.some(a => a.length > 1024 || a.includes("\0")) || payload.config.args.join(" ").length > 8000 ||
      payload.config.executable.length > 1024 || JSON.stringify(payload.config.env).length > 8000) throw transportFailure();
    const stdin = Buffer.from(canonical(payload));
    const request: CommandRequest = { command: sbx, args: ["exec", "-i", "-u", "root", sandbox, "node", "-e", PHASE_GUARD, reportHash(stdin)], env,
      stdin, timeoutMs, maxOutputBytes: 2 * 1024 * 1024, sanitized: true };
    try { checkTransportCommand(commands, request); } catch { throw transportFailure(binding, stdin.length, reportHash(stdin)); }
    const ref = await store.write(payload, binding);
    const exact = await store.read(ref, binding);
    if (!exact.equals(stdin) || canonical(payload.binding) !== canonical(binding)) throw transportFailure();
    signal?.throwIfAborted();
    await prepare?.();
    const consumed = await store.read(ref, binding);
    if (!consumed.equals(exact)) throw transportFailure();
    dispatched = true;
    try {
      const result = await commands.run({ ...request, stdin: consumed }, signal);
      observed = result.stdoutBytes;
      return result;
    } catch (error) {
      if (error instanceof CommandExecutionError) observed = error.stdoutBytes;
      throw error;
    }
  } finally {
    await store.release();
    if (dispatched && payload.config.control) {
      // Local sbx exit is not proof of remote Pi termination. The root guard
      // alone writes done after observed child close; cancellation is durable.
      const control = payload.config.control;
      const script = `set -eu; touch '${control}/cancel'; i=0; while [ ! -f '${control}/done' ]; do i=$((i+1)); [ "$i" -lt 100 ] || { echo 'remote phase termination unobserved' >&2; exit 1; }; sleep 0.1; done`;
      try { await commands.run({ command: sbx, args: ["exec", "-u", "root", sandbox, "sh", "-lc", script], env, timeoutMs: 15000, sanitized: true }); }
      catch { throw new CommandExecutionError("infrastructure", "phase_transport: remote phase termination unobserved; operator must inspect retained transport evidence and authorize a fresh attempt; do not promote candidate", observed?.toString("utf8") ?? "", undefined, observed); }
    }
  }
}
