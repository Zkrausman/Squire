import {createHash, randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {validateGeneratedSourcePayload, observeGeneratedSyntax} from './limited-stream-collector.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
// Explicit filesystem port; no process execution, durable ledger or hostile-writer protection.
export async function stageGeneratedSource({run_root, source_bytes, signal}, ports) {
  if (!(source_bytes instanceof Uint8Array) || !signal || typeof run_root !== 'string') throw Error('INVALID_SOURCE_STAGE');
  const source = new TextDecoder('utf-8', {fatal:true,ignoreBOM:true}).decode(source_bytes);
  const payload = validateGeneratedSourcePayload(source), syntax = observeGeneratedSyntax(source, ports);
  const bytes = new Uint8Array(payload.source_bytes), fs = ports.fs;
  const check = () => {if(signal.aborted) throw Error('PERSISTENCE_ABORTED');};
  const stage = join(run_root, 'stage', '.stage-' + randomUUID() + '.mjs');
  const destination = join(run_root,'workspace','src','summarizer.mjs');
  let ownedStage = false, handle;
  try {
    check();
    for (const path of [join(run_root,'stage'),join(run_root,'workspace'),join(run_root,'workspace','src')]) {
      await fs.mkdir(path,{mode:0o700}); check();
    }
    handle = await fs.open(stage,'wx',0o600); ownedStage = true; check();
    await handle.writeFile(bytes); check(); await handle.close(); handle = null; check();
    const readback = await fs.readFile(stage); check();
    if (readback.length !== bytes.length || digest(readback) !== payload.source_sha256) throw Error('STAGE_DIGEST_MISMATCH');
    await fs.link(stage,destination); check();
    await fs.unlink(stage); ownedStage = false; check();
    await fs.chmod(destination,0o400); check();
    const physical = await fs.readFile(destination); check();
    const st = await fs.lstat(destination); check();
    if (!st.isFile() || st.isSymbolicLink() || (st.mode & 0o777) !== 0o400 || physical.length !== bytes.length || digest(physical) !== payload.source_sha256)
      throw Error('PUBLISHED_SOURCE_WITNESS_MISMATCH');
    const witness_timestamp_ms = ports.clock.now(); check();
    if (!Number.isSafeInteger(witness_timestamp_ms) || witness_timestamp_ms < 0) throw Error('WITNESS_CLOCK_INVALID');
    return Object.freeze({source_path:destination,source_sha256:payload.source_sha256,source_byte_count:bytes.length,
      format_status:'FORMAT_VALID',syntax_observation:syntax.syntax_status,witness_locked:true,destination_mode:'0o400',witness_timestamp_ms});
  } catch(e) {
    // Only the stage we created is eligible for cleanup. Never compensate by deleting a final name.
    if(handle) try {await handle.close();} catch {}
    if(ownedStage) try {await fs.unlink(stage);} catch {}
    if(e.code === 'EEXIST') throw Error('COLLISION_FAIL_CLOSED');
    throw e;
  } finally {bytes.fill(0);}
}
