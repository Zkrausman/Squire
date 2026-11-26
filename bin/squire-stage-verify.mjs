// Verify a selected local stage or export against an independently retained digest.
import * as fs from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {verifyStage, verifyLargeProjectStage} from '../src/multifile-staging.mjs';
import {verifyExport, verifyLargeProjectExport} from '../src/multifile-export.mjs';

const usage = 'Usage: node bin/squire-stage-verify.mjs <standard|large> <stage|export> <absolute-copy-dir> <expected-manifest-sha256>\n';
const profiles = new Map([
  ['standard', new Map([['stage', verifyStage], ['export', verifyExport]])],
  ['large', new Map([['stage', verifyLargeProjectStage], ['export', verifyLargeProjectExport]])],
]);

function selectedDirectory(path) {
  return path.length > 1 && path.length <= 4096 && path.startsWith('/') &&
    resolve(path) === path && !/[\\\u0000-\u001f\u007f]/u.test(path);
}

function reject(diagnostic) {
  process.exitCode = 2;
  process.stderr.write(diagnostic + '\n');
}

async function main(args) {
  if (args.length === 1 && args[0] === '--help') {
    process.stdout.write(usage);
    return;
  }
  const [profile, kind, directory, expected] = args;
  const verify = profiles.get(profile)?.get(kind);
  if (args.length !== 4 || !verify || !selectedDirectory(directory)) {
    reject(usage.trimEnd());
    return;
  }
  if (expected.length !== 64 || !/^[a-f0-9]{64}$/.test(expected)) {
    reject('INVALID_EXPECTED_MANIFEST_SHA256');
    return;
  }
  try {
    const result = await verify(directory, {fs, uid: process.getuid()});
    if (result.status !== 'VERIFIED' || result.exit_code !== 0) {
      reject('CORRUPT_OR_INCOMPLETE');
      return;
    }
    if (result.manifest_sha256 !== expected) {
      reject('MANIFEST_BINDING_MISMATCH');
      return;
    }
    const {status, manifest_sha256, total_bytes, original_operation_acknowledgement,
      provenance_authenticity, crash_durability} = result;
    const total_files = kind === 'stage' ? result.file_count : result.total_files;
    process.stdout.write(JSON.stringify({profile, kind, status, manifest_sha256, total_files,
      total_bytes, original_operation_acknowledgement, provenance_authenticity, crash_durability}) + '\n');
  } catch {
    reject('CORRUPT_OR_INCOMPLETE');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const outputError = () => { process.exitCode = 2; };
  process.stdout.on('error', outputError);
  process.stderr.on('error', outputError);
  await main(process.argv.slice(2));
}
