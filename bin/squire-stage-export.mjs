// Export one explicitly selected stage through the existing custody boundary.
import * as fs from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {buildExport, buildLargeProjectExport, safeMultifileErrorCode} from '../src/multifile-export.mjs';
import {PROJECT_OUTPUT_LARGE_PROFILE} from '../src/project-coding-profile.mjs';

const usage = 'Usage: node bin/squire-stage-export.mjs [standard|large] <absolute-stage-dir> <expected-stage-manifest-sha256> <operation-id> <caller-label> <fresh-absolute-export-dir>\n' +
  'Omitting the profile selects standard (legacy invocation).\n';

function selectedDirectory(path) {
  return path.length > 1 && path.length <= 4096 && path.startsWith('/') &&
    resolve(path) === path && !/[\\\u0000-\u001f\u007f]/u.test(path);
}

async function main(args) {
  if (args.length === 1 && args[0] === '--help') {
    process.stdout.write(usage);
    return;
  }
  const [profile, stageDir, expected, operation, label, exportDir] = args.length === 5
    ? ['standard', ...args] : args;
  if (![5, 6].includes(args.length) || !['standard', 'large'].includes(profile) ||
      !selectedDirectory(stageDir) || !selectedDirectory(exportDir)) {
    process.exitCode = 2;
    process.stderr.write(usage);
    return;
  }
  try {
    const build = profile === 'large' ? buildLargeProjectExport : buildExport;
    const receipt = await build({
      stage_dir: stageDir,
      stage_manifest_sha256: expected,
      export_operation_id: operation,
      caller_label: label,
      export_dir: exportDir,
      ...(profile === 'large' ? {output_profile: PROJECT_OUTPUT_LARGE_PROFILE} : {}),
    }, {fs, uid: process.getuid()});
    const {operation_acknowledgement, manifest_sha256, total_files, total_bytes} = receipt;
    process.stdout.write(JSON.stringify({operation_acknowledgement, manifest_sha256, total_files, total_bytes}) + '\n');
  } catch (error) {
    process.exitCode = 2;
    process.stderr.write(safeMultifileErrorCode(error) + '\n');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const outputError = () => { process.exitCode = 2; };
  process.stdout.on('error', outputError);
  process.stderr.on('error', outputError);
  await main(process.argv.slice(2));
}
