import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const RUN_ID = /^squire-[0-9]{10,16}-[a-f0-9]{10}$/;
const TICKET_ID = /^[A-Z][A-Z0-9]{1,15}-[1-9][0-9]{0,8}$/;
const RECENT_MS = 24 * 60 * 60_000;
const MAX_READ_FILES = 128;
const MAX_STORED = 64;
const MAX_VISIBLE = 8;
const MAX_BYTES = 1024;
const DIR = 'recent-outcomes-v1';
const NEXT_GATE = 'Independent review, applicable tests, and exact-head hosted CI';
const KEY_FILE = '.recent-outcomes-key-v1';

async function readKey(root, create = false) {
  const file = path.join(root,KEY_FILE);
  if (create) {
    await mkdir(root,{recursive:true,mode:0o700});
    try { await writeFile(file,randomBytes(32),{flag:'wx',mode:0o600}); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== 32) throw new Error('Invalid recent receipt key');
  return readFile(file);
}
function signature(value,key) {
  const {mac:ignored,...body}=value;
  return createHmac('sha256',key).update(JSON.stringify(body)).digest('hex');
}

function valid(value, runId, now) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === 'completedAtMs,mac,runId,status,ticketId,ticketName,version'
    && ((value.version === 1 && value.status === 'UNVERIFIED')
      || (value.version === 2 && value.status === 'CANDIDATE_CREATED'))
    && value.runId === runId && RUN_ID.test(runId)
    && TICKET_ID.test(value.ticketId) && typeof value.ticketName === 'string'
    && value.ticketName.length > 0 && value.ticketName.length <= 100
    && !/[\u0000-\u001f\u007f-\u009f]/.test(value.ticketName)
    && Number.isSafeInteger(value.completedAtMs)
    && value.completedAtMs > 0 && value.completedAtMs <= now + 2_000
    && now - value.completedAtMs <= RECENT_MS;
}

function recentDir(root) { return path.join(root, DIR); }

export async function readRecentOutcomes(root, now = Date.now()) {
  const dir = recentDir(root);
  let key;
  try {
    if (!(await lstat(dir)).isDirectory()) return [];
    key = await readKey(root);
  } catch { return []; }
  let names;
  try { names = await readdir(dir); } catch { return []; }
  // A stale surplus must not permanently hide later receipts. Run IDs start with
  // creation time, so sample a bounded set of the newest recognized identities.
  const candidates = names.filter(name => name.endsWith('.json') && RUN_ID.test(name.slice(0,-5)))
    .sort().reverse().slice(0,MAX_READ_FILES);
  const rows = [];
  for (const name of candidates) {
    try {
      const file = path.join(dir, name);
      const stat = await lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES) continue;
      const value = JSON.parse(await readFile(file, 'utf8'));
      if (!valid(value, name.slice(0, -5), now) || !/^[a-f0-9]{64}$/.test(value.mac)) continue;
      const expected=Buffer.from(signature(value,key),'hex');
      if (!timingSafeEqual(expected,Buffer.from(value.mac,'hex'))) continue;
      rows.push({ runId:value.runId, ticketId:value.ticketId, ticketName:value.ticketName,
        completedAtMs:value.completedAtMs, status:'Code candidate created', nextGate:NEXT_GATE });
    } catch { /* A racing, corrupt, or linked receipt is not trusted. */ }
  }
  return rows.sort((a,b)=>b.completedAtMs-a.completedAtMs || a.runId.localeCompare(b.runId)).slice(0,MAX_VISIBLE);
}

// Called only after the runner has persisted its terminal `candidate` state.
// This is a presence receipt, not Verify, publication, ticket completion or approval.
export async function writeCandidateOutcome({ root, runId, ticketId, ticketName, completedAtMs = Date.now() }) {
  const value = { version:2, runId, ticketId, ticketName, completedAtMs, status:'CANDIDATE_CREATED', mac:'0'.repeat(64) };
  if (!valid(value, runId, Date.now())) throw new Error('Invalid candidate outcome identity');
  const dir = recentDir(root);
  const key = await readKey(root,true);
  value.mac = signature(value,key);
  await mkdir(dir, { recursive:true, mode:0o700 });
  const destination = path.join(dir, `${runId}.json`);
  const temporary = path.join(dir, `.${randomBytes(12).toString('hex')}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(value)}\n`, {flag:'wx',mode:0o600});
    await rename(temporary,destination);
  } finally { await rm(temporary,{force:true}).catch(()=>{}); }
  // Best-effort pruning is confined to receipt filenames. An old surplus
  // is recoverable and later candidates stay visible without manual cleanup.
  try {
    const names = (await readdir(dir)).filter(name=>name.endsWith('.json') && RUN_ID.test(name.slice(0,-5)))
      .sort().reverse();
    for (const name of names.slice(MAX_STORED)) await rm(path.join(dir,name),{force:true}).catch(()=>{});
  } catch { /* Optional pruning must not change the primary run outcome. */ }
}
