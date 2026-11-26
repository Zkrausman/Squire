import {writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {readReceiptBytes} from './squire-report.mjs';
import {CODEX_BYTE_LIMITS} from '../src/codex-profile.mjs';
import {parseSingleJsRequest, buildSingleJsCodegenPrompt} from '../src/single-js-task.mjs';
import {parseProjectRequest, buildProjectCodegenPrompt, DESKTOP_TARGET} from '../src/project-task.mjs';

const usage = 'Usage: node bin/squire-request-create.mjs <single-js|node|desktop> <task-id> <instruction.txt> <new-request.json>\n';

function requestBytes(family, task_id, task_prompt) {
  const single = family === 'single-js';
  const fields = single
    ? {schema: 'SQUIRE2_SINGLE_JS_REQUEST_V1', runtime_target: 'node24-esm', output_target: 'src/task.mjs'}
    : {schema: 'SQUIRE2_PROJECT_REQUEST_V1', runtime_target: family === 'desktop' ? DESKTOP_TARGET : 'node24-esm', stage_target: 'multifile-candidate'};
  const bytes = Buffer.from(JSON.stringify({...fields, task_id, task_prompt}, null, 2));
  // Check the exact serialized file and the family-specific prefixed prompt.
  if (single) buildSingleJsCodegenPrompt(parseSingleJsRequest(bytes));
  else buildProjectCodegenPrompt(parseProjectRequest(bytes));
  return bytes;
}

async function create(args) {
  if (args.length === 1 && args[0] === '--help') return {output: usage};
  const [family, id, input, destination] = args;
  if (args.length !== 4 || !['single-js', 'node', 'desktop'].includes(family) || !id || !input || !destination) {
    return {error: usage};
  }

  let inputBytes;
  try {
    inputBytes = await readReceiptBytes(input, CODEX_BYTE_LIMITS.max_prompt_bytes);
  } catch (error) {
    return {error: error === 'FILE_TOO_LARGE' ? 'INSTRUCTION_TOO_LARGE\n' : 'INSTRUCTION_READ_FAILED\n'};
  }
  let bytes;
  try {
    // Keep a leading BOM visible to the production parser.
    const prompt = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(inputBytes);
    bytes = requestBytes(family, id, prompt);
  } catch (error) {
    return {error: error.field === 'PAYLOAD_SIZE_EXCEEDED' ? 'REQUEST_TOO_LARGE\n' : 'INVALID_REQUEST\n'};
  }
  try {
    await writeFile(destination, bytes, {flag: 'wx', mode: 0o600});
  } catch (error) {
    return {error: error.code === 'EEXIST' ? 'DESTINATION_OCCUPIED\n' : 'REQUEST_WRITE_FAILED\n'};
  }
  return {output: 'REQUEST_CREATED\n'};
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const outputError = () => { process.exitCode = 2; };
  process.stdout.on('error', outputError);
  process.stderr.on('error', outputError);
  const result = await create(process.argv.slice(2));
  if (result.error) {
    process.exitCode = 2;
    process.stderr.write(result.error);
  } else {
    process.stdout.write(result.output);
  }
}
