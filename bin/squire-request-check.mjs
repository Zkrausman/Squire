// Optional read-only check of one public-text request.
import {pathToFileURL} from 'node:url';
import {readReceiptBytes} from './squire-report.mjs';
import {CODEX_BYTE_LIMITS} from '../src/codex-profile.mjs';
import {ContractError} from '../src/job-spec.mjs';
import {parseSingleJsRequest, buildSingleJsCodegenPrompt} from '../src/single-js-task.mjs';
import {parseProjectRequest, buildProjectCodegenPrompt, DESKTOP_TARGET} from '../src/project-task.mjs';

const usage = 'Usage: node bin/squire-request-check.mjs <single-js|node|desktop> <request.json>\n';
const families = new Map([
  ['single-js', {target: 'node24-esm', parse: parseSingleJsRequest, build: buildSingleJsCodegenPrompt}],
  ['node', {target: 'node24-esm', parse: parseProjectRequest, build: buildProjectCodegenPrompt}],
  ['desktop', {target: DESKTOP_TARGET, parse: parseProjectRequest, build: buildProjectCodegenPrompt}],
]);

function correction(error) {
  if (error instanceof ContractError) {
    switch (error.field) {
      case 'DUPLICATE_KEY_CONFLICT': return 'DUPLICATE_KEY';
      case 'MALFORMED_JSON': return 'INVALID_JSON';
      case 'MALFORMED_UTF8':
      case 'PROJECT_ENCODING_REJECTED': return 'INVALID_ENCODING';
      case 'single_js_prompt':
      case 'project_prompt': return 'INVALID_INSTRUCTION';
      case 'UNEXPECTED_FIELD':
      case 'single_js_request':
      case 'project_request':
      case 'PROJECT_AGGREGATE_CAPACITY_EXCEEDED':
      case 'PROJECT_SCHEMA_MISMATCH': return 'CHECK_REQUEST_SHAPE_OR_FAMILY';
      case 'PAYLOAD_SIZE_EXCEEDED': return 'REQUEST_TOO_LARGE';
    }
  }
  return 'REQUEST_CHECK_FAILED';
}

async function check(args) {
  if (args.length === 1 && args[0] === '--help') return {output: usage};
  const [family, path] = args;
  const profile = families.get(family);
  if (args.length !== 2 || !profile || !path) return {error: usage};

  let bytes;
  try {
    bytes = await readReceiptBytes(path, 65536);
  } catch (error) {
    return {error: error === 'FILE_TOO_LARGE' ? 'REQUEST_TOO_LARGE\n' : 'REQUEST_READ_FAILED\n'};
  }
  try {
    const request = profile.parse(bytes);
    if (request.runtime_target !== profile.target) return {error: 'CHECK_REQUEST_SHAPE_OR_FAMILY\n'};
    const promptBytes = profile.build(request).byteLength;
    const instructionBytes = Buffer.byteLength(request.task_prompt, 'utf8');
    const summary = {
      family,
      runtime_target: profile.target,
      instruction_bytes: instructionBytes,
      prefix_bytes: promptBytes - instructionBytes,
      remaining_prompt_bytes: CODEX_BYTE_LIMITS.max_prompt_bytes - promptBytes,
    };
    return {output: JSON.stringify(summary) + '\n'};
  } catch (error) {
    return {error: correction(error) + '\n'};
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const outputError = () => { process.exitCode = 2; };
  process.stdout.on('error', outputError);
  process.stderr.on('error', outputError);
  const result = await check(process.argv.slice(2));
  if (result.error) {
    process.exitCode = 2;
    process.stderr.write(result.error);
  } else {
    process.stdout.write(result.output);
  }
}
