// Author a project payload from explicitly selected synthetic fixture files.
import {constants} from 'node:fs';
import {lstat, open, writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {PROJECT_OUTPUT_LARGE_PROFILE} from '../src/project-coding-profile.mjs';
import {validateProjectPayloadJson, validateLargeProjectPayloadJson} from '../src/project-task.mjs';

const usage = 'Usage: node bin/squire-author-envelope.mjs <standard|large> <fresh-envelope.json> ' +
  '--file <local-file> <wire-path> <SOURCE|DOC|LOCAL_ASSET> <utf-8|base64> [--file ...]\n' +
  'Select only synthetic fixture files. The command reads file bytes in declaration order.\n';
const profiles = new Map([
  ['standard', {maxDecoded: 1048576, validate: validateProjectPayloadJson}],
  ['large', {maxDecoded: PROJECT_OUTPUT_LARGE_PROFILE.max_decoded_project_bytes, validate: validateLargeProjectPayloadJson}],
]);
const maxFileBytes = 524288; // Largest single file admitted by either decoder.
const textDecoder = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true});

function parseArgs([profile, destination, ...args]) {
  const policy = profiles.get(profile);
  if (!policy || !destination || !args.length || args.length % 5 ||
      args.length / 5 > PROJECT_OUTPUT_LARGE_PROFILE.max_all_files) throw new Error(usage);
  const declarations = [];
  for (let i = 0; i < args.length; i += 5) {
    const [flag, local, path, classification, encoding] = args.slice(i, i + 5);
    if (flag !== '--file' || !local || !path || !['SOURCE', 'DOC', 'LOCAL_ASSET'].includes(classification) ||
        !['utf-8', 'base64'].includes(encoding)) throw new Error(usage);
    declarations.push({local, path, classification, encoding});
  }
  return {policy, destination, declarations};
}

async function readSelectedFile(path, limit) {
  const before = await lstat(path, {bigint: true});
  if (!before.isFile() || before.size > limit) throw new Error('Invalid fixture input');
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat({bigint: true});
    if (!stat.isFile() || stat.dev !== before.dev || stat.ino !== before.ino || stat.size > limit) {
      throw new Error('Invalid fixture input');
    }
    const bytes = Buffer.alloc(Number(stat.size));
    let offset = 0;
    while (offset < bytes.length) {
      const {bytesRead} = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) throw new Error('Incomplete fixture input');
      offset += bytesRead;
    }
    const after = await handle.stat({bigint: true});
    if (after.size !== stat.size || after.mtimeNs !== stat.mtimeNs || after.ctimeNs !== stat.ctimeNs) {
      throw new Error('Fixture input changed');
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

async function author({policy, destination, declarations}) {
  const originals = [];
  const files = [];
  let remaining = policy.maxDecoded;
  for (const {local, path, classification, encoding} of declarations) {
    const bytes = await readSelectedFile(local, Math.min(remaining, maxFileBytes));
    remaining -= bytes.length;
    originals.push(bytes);
    const content = encoding === 'base64' ? bytes.toString('base64') : textDecoder.decode(bytes);
    files.push({path, classification, encoding, content});
  }
  const envelope = Buffer.from(JSON.stringify({schema: 'SQUIRE2_PROJECT_FILE_ENVELOPE_V1', files}));
  const decoded = policy.validate(envelope).files;
  if (decoded.length !== originals.length || !decoded.every((file, i) =>
    file.path === files[i].path && file.classification === files[i].classification &&
    originals[i].equals(file.content))) throw new Error('Fixture round trip failed');

  await writeFile(destination, envelope, {flag: 'wx', mode: 0o600});
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const outputError = () => { process.exitCode = 2; };
  process.stdout.on('error', outputError);
  process.stderr.on('error', outputError);
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') {
    process.stdout.write(usage);
  } else {
    try {
      await author(parseArgs(args));
      process.stdout.write('SYNTHETIC_ENVELOPE_WRITTEN\n');
    } catch (error) {
      process.exitCode = 2;
      process.stderr.write(error.message === usage ? usage : 'SYNTHETIC_ENVELOPE_REJECTED\n');
    }
  }
}
