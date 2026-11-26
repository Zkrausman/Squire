import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {artifactCliChild} from './helpers/artifact-cli-child.mjs';
import {SINGLE_JS_PREFIX, buildSingleJsCodegenPrompt} from '../src/single-js-task.mjs';
import {PROJECT_CODEGEN_PREFIX, DESKTOP_CODEGEN_PREFIX, buildProjectCodegenPrompt} from '../src/project-task.mjs';

const cli = new URL('../bin/squire-request-check.mjs', import.meta.url);
const profiles = [
  {family: 'single-js', target: 'node24-esm', prefix: SINGLE_JS_PREFIX, build: buildSingleJsCodegenPrompt},
  {family: 'node', target: 'node24-esm', prefix: PROJECT_CODEGEN_PREFIX, build: buildProjectCodegenPrompt},
  {family: 'desktop', target: 'desktop-gjs-gtk4', prefix: DESKTOP_CODEGEN_PREFIX, build: buildProjectCodegenPrompt},
];

function request(profile, prompt) {
  const fields = {task_id: 'private_test_id', task_prompt: prompt, runtime_target: profile.target};
  return profile.family === 'single-js'
    ? {...fields, schema: 'SQUIRE2_SINGLE_JS_REQUEST_V1', output_target: 'src/task.mjs'}
    : {...fields, schema: 'SQUIRE2_PROJECT_REQUEST_V1', stage_target: 'multifile-candidate'};
}

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'private-request-'));
  t.after(() => rm(dir, {force: true, recursive: true}));
  return join(dir, 'private-name.json');
}

function rejected(result, diagnostic) {
  assert.equal(result.code, 2);
  assert.equal(result.signal, null);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, diagnostic + '\n');
}

// Observe the CLI in its own process, including the real bounded reader.
// Any unexpected I/O fails the test even if the command catches the exception.
const readOnlyProbe = `
  const {default: fs} = await import('node:fs/promises');
  const {constants} = await import('node:fs');
  const {default: cp} = await import('node:child_process');
  const {syncBuiltinESMExports} = await import('node:module');
  const path = process.argv.at(-1);
  let opens = 0, unexpected = 0;
  const forbid = () => { unexpected++; throw Error('unexpected fixture operation'); };
  const open = fs.open;
  fs.open = (name, flags) => {
    if (name !== path || flags !== (constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)) forbid();
    opens++;
    return open(name, flags);
  };
  for (const method of ['readFile', 'writeFile', 'mkdir', 'appendFile', 'copyFile', 'rename', 'rm']) fs[method] = forbid;
  for (const method of ['spawn', 'spawnSync', 'exec', 'execFile', 'execSync', 'execFileSync', 'fork']) cp[method] = forbid;
  syncBuiltinESMExports();
  process.once('exit', () => { if (opens !== 1 || unexpected !== 0) process.exitCode = 97; });
`;

for (const profile of profiles) {
  test('request checker measures actual built bytes for ' + profile.family, async t => {
    const path = await fixture(t);
    const prefixBytes = Buffer.byteLength(profile.prefix);
    const budget = 32768 - prefixBytes;
    for (const prompt of [
      'Private instruction. '.repeat(6),
      'x'.repeat(budget),
      'é'.repeat(Math.floor(budget / 2)) + 'x'.repeat(budget % 2),
    ]) {
      const value = request(profile, prompt);
      await writeFile(path, JSON.stringify(value));
      const result = await artifactCliChild(cli, [profile.family, path], {before: readOnlyProbe});
      assert.equal(result.code, 0);
      assert.equal(result.signal, null);
      assert.equal(result.stderr, '');
      const built = profile.build(value);
      const instruction = Buffer.from(prompt);
      assert.deepEqual(Buffer.from(built.subarray(prefixBytes)), instruction);
      assert.deepEqual(JSON.parse(result.stdout), {
        family: profile.family, runtime_target: profile.target, instruction_bytes: instruction.length,
        prefix_bytes: prefixBytes, remaining_prompt_bytes: 32768 - built.byteLength,
      });
    }
  });

  test('request checker rejects invalid instructions and duplicate keys for ' + profile.family, async t => {
    const path = await fixture(t);
    const budget = 32768 - Buffer.byteLength(profile.prefix);
    const over = 'x'.repeat(budget - 1) + 'é';
    assert.equal(Buffer.byteLength(over), budget + 1);
    for (const prompt of [over, 'x'.repeat(budget + 1), ' \t'.repeat(50)]) {
      await writeFile(path, JSON.stringify(request(profile, prompt)));
      rejected(await artifactCliChild(cli, [profile.family, path]), 'INVALID_INSTRUCTION');
    }
    const text = JSON.stringify(request(profile, 'private instruction '.repeat(6)));
    await writeFile(path, text.replace('{', '{"task_id":"secret",'));
    rejected(await artifactCliChild(cli, [profile.family, path]), 'DUPLICATE_KEY');
  });
}

test('family is explicit even when two request shapes share a parser or runtime', async t => {
  const path = await fixture(t);
  for (const profile of profiles) {
    await writeFile(path, JSON.stringify(request(profile, 'private instruction '.repeat(6))));
    for (const other of profiles.filter(p => p !== profile)) {
      rejected(await artifactCliChild(cli, [other.family, path]), 'CHECK_REQUEST_SHAPE_OR_FAMILY');
    }
  }
});

test('request file bounds, decoding and open failures give finite corrections', async t => {
  const path = await fixture(t);
  rejected(await artifactCliChild(cli, ['single-js', path]), 'REQUEST_READ_FAILED');
  for (const [bytes, diagnostic] of [
    [Buffer.alloc(65537, 32), 'REQUEST_TOO_LARGE'],
    [Buffer.from([0xff]), 'INVALID_ENCODING'],
    ['{"private":', 'INVALID_JSON'],
  ]) {
    await writeFile(path, bytes);
    rejected(await artifactCliChild(cli, ['node', path]), diagnostic);
  }
  await symlink(path, path + '-link');
  rejected(await artifactCliChild(cli, ['node', path + '-link']), 'REQUEST_READ_FAILED');
});

test('usage handles unknown families and extra operands before opening a file', async () => {
  const help = await artifactCliChild(cli, ['--help']);
  assert.equal(help.code, 0);
  assert.equal(help.stderr, '');
  assert.match(help.stdout, /<single-js\|node\|desktop>/);
  for (const args of [[], ['private-family', 'private-file'], ['node', 'private-file', 'private-config']]) {
    rejected(await artifactCliChild(cli, args), help.stdout.trimEnd());
  }
});

test('closed help output and a closed diagnostic stream exit quietly with code 2', async () => {
  for (const [args, closed] of [[['--help'], 'stdout'], [[], 'stderr']]) {
    const result = await artifactCliChild(cli, args, {closed});
    assert.equal(result.code, 2);
    assert.equal(result.signal, null);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
  }
});
