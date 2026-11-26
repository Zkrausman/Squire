// Materialize explicitly selected synthetic bytes; never execute or admit a candidate.
import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import * as fs from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {PROJECT_OUTPUT_LARGE_PROFILE} from '../src/project-coding-profile.mjs';
import {validateProjectPayloadJson, validateLargeProjectPayloadJson} from '../src/project-task.mjs';
import {
  planStaging, writeStage, verifyStage,
  planLargeProjectStaging, writeLargeProjectStage, verifyLargeProjectStage,
} from '../src/multifile-staging.mjs';

const usage = 'Usage: node bin/squire-materialize-envelope.mjs <standard|large> <synthetic-envelope.json> <operation-id> <fresh-absolute-stage-dir>\n';
const profiles = new Map([
  ['standard', {limit: 1048576, decode: validateProjectPayloadJson,
    plan: planStaging, write: writeStage, verify: verifyStage}],
  ['large', {limit: PROJECT_OUTPUT_LARGE_PROFILE.max_envelope_bytes,
    decode: validateLargeProjectPayloadJson,
    plan: spec => planLargeProjectStaging({...spec, output_profile: PROJECT_OUTPUT_LARGE_PROFILE}),
    write: writeLargeProjectStage, verify: verifyLargeProjectStage}],
]);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const label = 'synthetic_stage_fixture';

function validArgs(profile, envelopePath, operationId, stageDir) {
  return profiles.has(profile) && typeof envelopePath === 'string' && !!envelopePath &&
    typeof operationId === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(operationId) &&
    typeof stageDir === 'string' && stageDir.length > 1 && stageDir.length <= 4096 &&
    stageDir.startsWith('/') && resolve(stageDir) === stageDir && !/[\\\u0000-\u001f\u007f]/u.test(stageDir);
}

async function readEnvelope(path, limit) {
  const before = await fs.lstat(path, {bigint: true});
  if (!before.isFile() || before.size > limit) throw Error('Invalid envelope input');
  const handle = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let bytes;
  try {
    const stat = await handle.stat({bigint: true});
    if (!stat.isFile() || stat.dev !== before.dev || stat.ino !== before.ino || stat.size > limit) {
      throw Error('Invalid envelope input');
    }
    bytes = Buffer.alloc(Number(stat.size));
    let offset = 0;
    while (offset < bytes.length) {
      const {bytesRead} = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) throw Error('Incomplete envelope input');
      offset += bytesRead;
    }
    const after = await handle.stat({bigint: true});
    if (after.size !== stat.size || after.mtimeNs !== stat.mtimeNs || after.ctimeNs !== stat.ctimeNs) {
      throw Error('Envelope input changed');
    }
    return bytes;
  } catch (error) {
    bytes?.fill(0);
    throw error;
  } finally {
    try { await handle.close(); } catch (error) { bytes?.fill(0); throw error; }
  }
}

// Explicit staging ports permit the same bounded writer to be tested on a failing copy.
export async function materializeSyntheticStage(profile, envelopePath, operationId, stageDir, ports) {
  if (!validArgs(profile, envelopePath, operationId, stageDir)) throw Error(usage);
  const policy = profiles.get(profile);
  let bytes, decoded, plan;
  try {
    bytes = await readEnvelope(envelopePath, policy.limit);
    const envelopeSha256 = hash(bytes);
    decoded = policy.decode(bytes);
    plan = policy.plan({stage_operation_id: operationId, caller_label: label,
      files: decoded.files.map(({path, classification, content}) => ({path, classification, content}))});
    // A successful writer alone is insufficient: verify the physical copy and bind it to the plan.
    const written = await policy.write(plan, stageDir, ports);
    const verified = await policy.verify(stageDir, ports);
    if (written.operation_acknowledgement !== 'ACKNOWLEDGED' ||
        written.manifest_sha256 !== plan.manifest_sha256 || verified.status !== 'VERIFIED' ||
        verified.manifest_sha256 !== plan.manifest_sha256 || verified.stage_operation_id !== operationId ||
        verified.caller_label !== label || verified.file_count !== decoded.files.length ||
        verified.total_bytes !== plan.total_bytes) throw Error('Fixture copy verification failed');
    return {schema: 'SQUIRE_SYNTHETIC_STAGE_COPY_V1', profile, copy_integrity: 'VERIFIED',
      envelope_sha256: envelopeSha256, stage_manifest_sha256: verified.manifest_sha256,
      file_count: verified.file_count, total_bytes: verified.total_bytes};
  } finally {
    bytes?.fill(0);
    for (const file of decoded?.files ?? []) file.content.fill(0);
    for (const file of plan?.files ?? []) file.content.fill(0);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const outputError = () => { process.exitCode = 2; };
  process.stdout.on('error', outputError);
  process.stderr.on('error', outputError);
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') {
    process.stdout.write(usage);
  } else if (args.length !== 4 || !validArgs(...args)) {
    process.exitCode = 2;
    process.stderr.write(usage);
  } else {
    try {
      const receipt = await materializeSyntheticStage(...args, {fs, uid: process.getuid()});
      process.stdout.write(JSON.stringify(receipt) + '\n');
    } catch {
      process.exitCode = 2;
      process.stderr.write('SYNTHETIC_STAGE_COPY_REJECTED\n');
    }
  }
}
