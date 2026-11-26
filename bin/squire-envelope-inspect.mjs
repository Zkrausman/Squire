// Inspect one proposed final-message envelope using the selected payload policy.
import {constants} from 'node:fs';
import {lstat, open} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {diagnosticReport} from '../src/internal/limited-diagnostics.mjs';
import {ContractError, fail} from '../src/job-spec.mjs';
import {PROJECT_OUTPUT_LARGE_PROFILE} from '../src/project-coding-profile.mjs';
import {validateProjectPayloadJson, validateLargeProjectPayloadJson} from '../src/project-task.mjs';

const usage = 'Usage: node bin/squire-envelope-inspect.mjs <standard|large> <envelope.json>\n' +
  'Checks envelope validity only. JSONL transport fit, syntax and functionality are unevaluated.\n';
const profiles = new Map([
  ['standard', {maxBytes: 1048576, validate: validateProjectPayloadJson}],
  ['large', {maxBytes: PROJECT_OUTPUT_LARGE_PROFILE.max_envelope_bytes, validate: validateLargeProjectPayloadJson}],
]);

async function readEnvelope(path, maxBytes) {
  const before = await lstat(path);
  if (!before.isFile()) throw new Error('Expected regular file');
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.dev !== before.dev || stat.ino !== before.ino) throw new Error('File changed');
    if (stat.size > maxBytes) fail('PROJECT_PAYLOAD_TOO_LARGE');
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const {bytesRead} = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) throw new Error('Incomplete read');
      offset += bytesRead;
    }
    const after = await handle.stat();
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) {
      throw new Error('File changed');
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

function summarize(profile, bytes, validate) {
  const {files} = validate(bytes);
  try {
    const filesByClass = {SOURCE: 0, LOCAL_ASSET: 0, DOC: 0};
    let decodedBytes = 0;
    for (const file of files) {
      filesByClass[file.classification]++;
      decodedBytes += file.bytes;
    }
    return {profile, envelope_valid: true, encoded_envelope_bytes: bytes.length,
      decoded_bytes: decodedBytes, files_by_class: filesByClass};
  } finally {
    for (const file of files) file.content.fill(0);
  }
}

async function inspect(args) {
  if (args.length === 1 && args[0] === '--help') return {output: usage};
  const [profile, path] = args;
  const policy = profiles.get(profile);
  if (args.length !== 2 || !policy || !path) return {error: usage};
  let bytes;
  try {
    bytes = await readEnvelope(path, policy.maxBytes);
    return {output: JSON.stringify(summarize(profile, bytes, policy.validate)) + '\n'};
  } catch (error) {
    if (error instanceof ContractError) return {error: diagnosticReport('PAYLOAD', error.field).reason + '\n'};
    return {error: bytes ? 'ENVELOPE_INSPECTION_FAILED\n' : 'ENVELOPE_READ_FAILED\n'};
  } finally {
    bytes?.fill(0);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const outputError = () => { process.exitCode = 2; };
  process.stdout.on('error', outputError);
  process.stderr.on('error', outputError);
  const result = await inspect(process.argv.slice(2));
  if (result.error) {
    process.exitCode = 2;
    process.stderr.write(result.error);
  } else {
    process.stdout.write(result.output);
  }
}
