// Guided input only: never inspect a source store, build a package or select a decision.
import * as fs from 'node:fs/promises';
import {constants} from 'node:fs';
import {basename, dirname} from 'node:path';
import {createInterface} from 'node:readline';
import {pathToFileURL} from 'node:url';
import {readReceiptBytes} from './squire-report.mjs';
import {parseReceiptJson} from '../src/offline-run-summary.mjs';
import {absolute, ancestors, closed, missing, stable} from '../src/internal/revision-review-core.mjs';

const usage = 'Usage: node bin/squire-review-bindings.mjs <original|revision> <fresh-bindings.json>\n';
const reject = () => { throw new Error('Rejected'); };
const overlap = (a, b) => a === b || a.startsWith(b + '/') || b.startsWith(a + '/');
const identityNumber = n => Number.isSafeInteger(n) && n >= 0;
const originalKeys = ['result_file', 'base_git_dir', 'base_git_identity',
  'candidate_git_dir', 'candidate_git_identity', 'output_dir'];

// Keep the local confirmation display unambiguous without changing input bytes.
const preview = value => JSON.stringify(value, null, 2).replace(
  /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/gu, character =>
    character === '\n' ? character : character.split('').map(unit =>
      '\\u' + unit.charCodeAt(0).toString(16).padStart(4, '0')).join(''));

function validateIdentity(value) {
  closed(value, ['dev', 'ino']);
  if (!identityNumber(value.dev) || !identityNumber(value.ino)) reject();
}

async function readOriginal(path) {
  await ancestors(fs, path);
  const before = await fs.lstat(path);
  const value = parseReceiptJson(await readReceiptBytes(path, 65536));
  if (!stable(before, await fs.lstat(path))) reject();
  closed(value, originalKeys);
  if (![value.result_file, value.base_git_dir, value.candidate_git_dir, value.output_dir].every(absolute)) reject();
  validateIdentity(value.base_git_identity);
  validateIdentity(value.candidate_git_identity);
  return value;
}

async function fresh(destination, bindings, reused) {
  const revision = Object.hasOwn(bindings, 'original_result_file');
  const base = bindings.base_git_dir;
  const inputs = [basename(base) === '.git' ? dirname(base) : base];
  if (revision) inputs.push(bindings.original_result_file, bindings.revised_result_file,
    bindings.original_git_dir, bindings.revised_git_dir, bindings.original_package.dir,
    ...bindings.prior_decisions.map(record => record.dir));
  else inputs.push(bindings.result_file, bindings.candidate_git_dir);
  if (reused) inputs.push(reused);
  for (const output of [destination, bindings.output_dir]) {
    if (inputs.some(input => overlap(input, output))) reject();
    await ancestors(fs, output);
    if (!await missing(fs, output)) reject();
  }
  if (overlap(destination, bindings.output_dir)) reject();
}

async function writeBindings(destination, value) {
  const bytes = Buffer.from(JSON.stringify(value, null, 2) + '\n');
  if (bytes.length > (Object.hasOwn(value, 'original_result_file') ? 262144 : 65536)) reject();
  const handle = await fs.open(destination, constants.O_WRONLY | constants.O_CREAT |
    constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    const check = async size => {
      const opened = await handle.stat(), leaf = await fs.lstat(destination);
      if (!leaf.isFile() || leaf.uid !== process.getuid() || leaf.nlink !== 1 ||
          (leaf.mode & 0o7777) !== 0o600 || leaf.size !== size || !stable(opened, leaf)) reject();
    };
    await check(0);
    await handle.writeFile(bytes);
    await check(bytes.length);
  } finally { await handle.close(); }
}

// Prompts and full review are deliberately local, private input UI, not status
// output suitable for sharing. No default or blank entry is accepted.
async function guide(family, destination, ask, show) {
  const path = async label => {
    const answer = await ask(label);
    if (!absolute(answer)) reject();
    return answer;
  };
  const integer = async (label, validator) => {
    const answer = await ask(label);
    if (!/^(0|[1-9][0-9]*)$/.test(answer) || !validator(Number(answer))) reject();
    return Number(answer);
  };
  const digest = async label => {
    const answer = await ask(label);
    if (!/^[a-f0-9]{64}$/.test(answer)) reject();
    return answer;
  };
  const confirm = async label => { if (await ask(label) !== 'yes') reject(); };
  const store = async (bindings, key) => {
    bindings[key + '_git_dir'] = await path(key + ' Git directory');
    bindings[key + '_git_identity'] = {
      dev: await integer(key + ' device (dev)', identityNumber),
      ino: await integer(key + ' inode (ino)', identityNumber),
    };
  };
  let bindings = {}, reused;
  if (family === 'original') {
    bindings.result_file = await path('Saved original result file');
    await store(bindings, 'base');
    await store(bindings, 'candidate');
  } else {
    const selection = await ask('Original result and stores: type enter or reuse');
    if (selection === 'reuse') {
      reused = await path('Explicit original bindings file to read');
      if (overlap(reused, destination)) reject();
      const original = await readOriginal(reused);
      bindings = {
        original_result_file: original.result_file,
        base_git_dir: original.base_git_dir,
        base_git_identity: original.base_git_identity,
        original_git_dir: original.candidate_git_dir,
        original_git_identity: original.candidate_git_identity,
      };
      await show('Review the exact reused fields (not the original output destination):\n' +
        preview(bindings) + '\n');
      await confirm('Use these exact original fields? Type yes');
    } else if (selection === 'enter') {
      bindings.original_result_file = await path('Saved original result file');
      await store(bindings, 'base');
      await store(bindings, 'original');
    } else reject();
    bindings.revised_result_file = await path('Saved first-revision result file');
    await store(bindings, 'revised');
    bindings.original_package = {
      dir: await path('Selected original package directory'),
      manifest_sha256: await digest('Independently retained original manifest SHA256'),
    };
    const count = await integer('Number of records in your complete declared prior decision set (1-8)',
      n => Number.isSafeInteger(n) && n >= 1 && n <= 8);
    bindings.prior_decisions = [];
    for (let n = 1; n <= count; n++) {
      bindings.prior_decisions.push({
        dir: await path('Prior record ' + n + ' directory'),
        file_sha256: await digest('Prior record ' + n + ' independently retained file SHA256'),
      });
    }
    bindings.selected_decision_id = await ask('Explicit selected prior REVISE decision ID');
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(bindings.selected_decision_id)) reject();
  }
  bindings.output_dir = await path('Fresh package directory');
  await fresh(destination, bindings, reused);
  await show('Review all supplied bindings and destination (private):\n' +
    preview({destination, bindings}) + '\n');
  await confirm('Write this new bindings document? Type yes');
  await fresh(destination, bindings, reused);
  return bindings;
}

async function main(args, write) {
  if (args.length === 1 && args[0] === '--help') {
    await write(process.stdout, usage);
    return;
  }
  const [family, destination] = args;
  if (args.length !== 2 || !['original', 'revision'].includes(family) || !absolute(destination)) reject();
  await ancestors(fs, destination);
  if (!await missing(fs, destination)) reject();

  const rl = createInterface({input: process.stdin, output: process.stdout, crlfDelay: Infinity,
    terminal: Boolean(process.stdin.isTTY && process.stdout.isTTY)});
  const lines = rl[Symbol.asyncIterator]();
  let interrupted = false;
  rl.on('SIGINT', () => { interrupted = true; rl.close(); });
  rl.on('error', () => { interrupted = true; rl.close(); });
  const show = text => write(process.stdout, text);
  const ask = async label => {
    await show(label + ': ');
    const {value, done} = await lines.next();
    if (interrupted || done || value.length > 4096) reject();
    return value;
  };
  try {
    await show('Private bindings draft only. No discovery, digest recovery or validation of candidate evidence.\n');
    const bindings = await guide(family, destination, ask, show);
    if (interrupted) reject();
    await writeBindings(destination, bindings);
    await show('PROJECT_REVIEW_BINDINGS_WRITTEN\nDRAFT_ONLY; VALIDATE_SEPARATELY_WITH_REVIEW_PREPARE\n');
  } finally { rl.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const failures = new Set();
  for (const stream of [process.stdout, process.stderr]) {
    stream.on('error', () => { failures.add(stream); process.exitCode = 2; });
  }
  const write = (stream, text) => new Promise((resolve, reject) => {
    if (failures.has(stream)) return reject(new Error('Output failed'));
    stream.write(text, error => error ? reject(error) : resolve());
  });
  try { await main(process.argv.slice(2), write); }
  catch {
    process.exitCode = 2;
    try { await write(process.stderr, 'PROJECT_REVIEW_BINDINGS_STOPPED; PRESERVE_OUTPUTS; NO_RETRY\n'); } catch {}
  }
}
