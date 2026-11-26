// Export one explicitly selected standard stage through the existing custody boundary.
import * as fs from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {buildExport, safeMultifileErrorCode} from '../src/multifile-export.mjs';

const usage = 'Usage: node bin/squire-stage-export.mjs <absolute-stage-dir> <expected-stage-manifest-sha256> <operation-id> <caller-label> <fresh-absolute-export-dir>\n';

function selectedDirectory(path) {
  return path.length > 1 && path.length <= 4096 && path.startsWith('/') &&
    resolve(path) === path && !/[\\\u0000-\u001f\u007f]/u.test(path);
}

async function main(args) {
  if (args.length === 1 && args[0] === '--help') {
    process.stdout.write(usage);
    return;
  }
  const [stageDir, expected, operation, label, exportDir] = args;
  if (args.length !== 5 || !selectedDirectory(stageDir) || !selectedDirectory(exportDir)) {
    process.exitCode = 2;
    process.stderr.write(usage);
    return;
  }
  try {
    const receipt = await buildExport({
      stage_dir: stageDir,
      stage_manifest_sha256: expected,
      export_operation_id: operation,
      caller_label: label,
      export_dir: exportDir,
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
