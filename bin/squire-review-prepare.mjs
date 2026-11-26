// Explicit offline prepare-only composition of the four existing CLI stages.
import * as fs from 'node:fs/promises';
import {basename, dirname} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify, isDeepStrictEqual} from 'node:util';
import {readReceiptBytes} from './squire-report.mjs';
import {parseReceiptJson} from '../src/offline-run-summary.mjs';
import {absolute, ancestors, missing, stable} from '../src/internal/revision-review-core.mjs';

const usage = 'Usage: node bin/squire-review-prepare.mjs <original|revision> <bindings.json> <fresh-spec.json> <fresh-worksheet.json>\n';
const scripts = Object.freeze({
  compose: fileURLToPath(new URL('./squire-review-spec.mjs', import.meta.url)),
  build: fileURLToPath(new URL('./squire-candidate-review.mjs', import.meta.url)),
  verify: fileURLToPath(new URL('./squire-candidate-review.mjs', import.meta.url)),
  worksheet: fileURLToPath(new URL('./squire-review-worksheet.mjs', import.meta.url)),
});
const overlap = (a, b) => a === b || a.startsWith(b + '/') || b.startsWith(a + '/');
const reject = () => { throw new Error('Rejected'); };

async function readJson(path, limit) {
  await ancestors(fs, path);
  const before = await fs.lstat(path);
  const bytes = Buffer.from(await readReceiptBytes(path, limit));
  const after = await fs.lstat(path);
  if (!after.isFile() || !stable(before, after)) reject();
  return {bytes, value: parseReceiptJson(bytes)};
}

// Extend the composer's explicit disjointness to the new worksheet destination.
// All original schema, result and physical checks still belong to its own stage.
async function preflight(family, bindingsPath, specPath, worksheetPath) {
  const revision = family === 'revision';
  const limit = revision ? 262144 : 65536;
  const {bytes, value: bindings} = await readJson(bindingsPath, limit);
  const base = bindings.base_git_dir;
  if (!absolute(base)) reject();
  const roots = [basename(base) === '.git' ? dirname(base) : base, bindings.output_dir];
  const selections = [bindingsPath, specPath];
  if (revision) {
    if (!Array.isArray(bindings.prior_decisions) || bindings.prior_decisions.length < 1 ||
        bindings.prior_decisions.length > 8) reject();
    roots.push(bindings.original_git_dir, bindings.revised_git_dir, bindings.original_package?.dir,
      ...bindings.prior_decisions.map(ref => ref?.dir));
    selections.push(bindings.original_result_file, bindings.revised_result_file);
  } else {
    roots.push(bindings.candidate_git_dir);
    selections.push(bindings.result_file);
  }
  if ([...roots, ...selections].some(p => !absolute(p) || overlap(p, worksheetPath))) reject();
  for (const destination of [specPath, bindings.output_dir, worksheetPath]) {
    await ancestors(fs, destination);
    if (!await missing(fs, destination)) reject();
  }
  return {bytes, bindings, limit};
}

async function runStage(stage, args) {
  // Fixed repository-owned scripts only; never launch any supplied source.
  const {stdout, stderr} = await promisify(execFile)(process.execPath,
    [scripts[stage], ...args], {encoding: 'utf8', maxBuffer: 16384});
  if (stderr !== '') reject();
  return stdout;
}

function buildDigest(output, family) {
  const prefix = family === 'revision' ? 'PROJECT_REVISION_REVIEW_PACKAGE_CREATED' :
    'PROJECT_CANDIDATE_REVIEW_PACKAGE_CREATED';
  const lines = output.split('\n');
  const digest = /^Manifest SHA256: ([a-f0-9]{64})$/.exec(lines[1] ?? '')?.[1];
  if (lines[0] !== prefix || !digest ||
      lines.at(-2) !== 'COPY_INTEGRITY_ONLY; NO_DECISION_OR_EXECUTION_AUTHORITY' ||
      lines.at(-1) !== '' || lines.filter(line => line.startsWith('Manifest SHA256:')).length !== 1) reject();
  return digest;
}

// The optional stage/report functions are trusted test ports, not CLI arguments.
// A failed child or missing acknowledgement never triggers a replay or cleanup.
export async function runReviewPrepare(args, {run = runStage, out, err} = {}) {
  if (args.length === 1 && args[0] === '--help') {
    try { await out(usage); return 0; } catch { return 2; }
  }
  const [family, bindingsPath, specPath, worksheetPath] = args;
  if (args.length !== 4 || !['original', 'revision'].includes(family) ||
      ![bindingsPath, specPath, worksheetPath].every(absolute) ||
      overlap(bindingsPath, specPath) || overlap(bindingsPath, worksheetPath) ||
      overlap(specPath, worksheetPath)) {
    try { await err(usage); } catch {}
    return 2;
  }
  let stage = 'PREFLIGHT', completed = 0;
  try {
    const {bytes, bindings, limit} = await preflight(family, bindingsPath, specPath, worksheetPath);
    stage = 'COMPOSE';
    if (await run('compose', [family, bindingsPath, specPath]) !== 'PROJECT_REVIEW_SPEC_COMPOSED\n') reject();
    completed = 1;
    await out('PROJECT_REVIEW_SPEC_COMPOSED\n');

    stage = 'BUILD_PREFLIGHT';
    // Check that the acknowledged spec still names the caller's bindings and
    // package destination; the separate builder independently validates it.
    if (!bytes.equals((await readJson(bindingsPath, limit)).bytes)) reject();
    const {value: spec} = await readJson(specPath, limit);
    for (const [key, value] of Object.entries(bindings)) {
      if (!key.endsWith('_result_file') && key !== 'result_file' &&
          !isDeepStrictEqual(spec[key], value)) reject();
    }
    await ancestors(fs, worksheetPath);
    if (!await missing(fs, worksheetPath)) reject();
    const packageDir = bindings.output_dir;
    const revision = family === 'revision';
    stage = 'BUILD';
    const built = await run('build', [revision ? '--build-revision' : '--build', specPath]);
    const expected = buildDigest(built, family);
    completed = 2;
    await out(`PROJECT_REVIEW_PACKAGE_BUILT\nManifest SHA256: ${expected}\n`);

    stage = 'VERIFY';
    const verified = await run('verify', [revision ? '--verify-revision' : '--verify',
      packageDir, '--expect-sha256', expected]);
    if (verified !== built.replace('_CREATED\n', '_VERIFIED\n')) reject();
    completed = 3;
    await out('PROJECT_REVIEW_PACKAGE_DIGEST_VERIFIED\n');

    stage = 'WORKSHEET';
    if (await run('worksheet', [family, packageDir, expected, worksheetPath]) !==
        'PROJECT_REVIEW_WORKSHEET_PREPARED\n') reject();
    completed = 4;
    await out('PROJECT_REVIEW_WORKSHEET_PREPARED\nPREPARE_ONLY; NO_DECISION_OR_EXECUTION_AUTHORITY\n');
    return 0;
  } catch {
    try {
      await err(`PROJECT_REVIEW_PREPARE_STOPPED stage=${stage} acknowledged_stages=${completed}\nPRESERVE_OUTPUTS; NO_RETRY_OR_ACK_RECOVERY\n`);
    } catch {}
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const failures = new Set();
  for (const stream of [process.stdout, process.stderr]) {
    stream.on('error', () => { failures.add(stream); process.exitCode = 2; });
  }
  const write = stream => text => new Promise((resolve, reject) => {
    if (failures.has(stream)) return reject(new Error('Output failed'));
    stream.write(text, error => error ? reject(error) : resolve());
  });
  const code = await runReviewPrepare(process.argv.slice(2),
    {out: write(process.stdout), err: write(process.stderr)});
  process.exitCode = failures.size ? 2 : code;
}
