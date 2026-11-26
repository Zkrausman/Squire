// Prepare a request from an explicitly completed, digest-bound review worksheet.
// No decision is recorded; imports are inert.
import {constants} from 'node:fs';
import * as fs from 'node:fs/promises';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {readReceiptBytes} from './squire-report.mjs';
import {REPORT_MAX_BYTES, parseRevisionDecisionJson} from '../src/offline-run-summary.mjs';
import {verifyProjectCandidateReviewPackage} from '../src/project-candidate-review-package.mjs';
import {absolute, ancestors, closed, digest, readFile, stable, TOKEN, verifyInternal as verifyRevision}
  from '../src/internal/revision-review-core.mjs';
import {MAX_REVIEW_DECISION_BYTES} from '../src/project-review-decision-limits.mjs';

const usage = 'Usage: node bin/squire-review-decision-request.mjs <original|revision> <package-dir> <expected-manifest-sha256> <completed-worksheet.json> <fresh-request.json>\n';
const fail = () => { throw new Error('Invalid worksheet or destination'); };
const overlaps = (a, b) => a === b || a.startsWith(b + '/') || b.startsWith(a + '/');

async function verifiedManifest(family, packageDir, expected) {
  if (family === 'revision') return (await verifyRevision(fs, packageDir, undefined, expected)).manifest;
  await verifyProjectCandidateReviewPackage(packageDir, {}, expected);
  // The public original verification result is a summary; rebind its exact
  // manifest bytes to the independently retained digest before projecting rows.
  const bytes = await readFile(fs, join(packageDir, 'review-manifest.json'), 256 * 1024);
  if (digest(bytes) !== expected) fail();
  return JSON.parse(bytes.toString('utf8'));
}

export async function readWorksheet(path) {
  await ancestors(fs, path);
  const privateFile = s => s.isFile() && s.uid === process.getuid() &&
    s.nlink === 1 && (s.mode & 0o7777) === 0o600;
  const before = await fs.lstat(path);
  if (!privateFile(before)) fail();
  // A full two-view worksheet can exceed the smaller decision request limit.
  const bytes = await readReceiptBytes(path, REPORT_MAX_BYTES);
  const after = await fs.lstat(path);
  if (!privateFile(after) || !stable(before, after) || bytes.length !== before.size) fail();
  // The existing duplicate-key-rejecting bounded grammar permits up to 100
  // array entries and 256 KiB. No permissive JSON.parse on owner responses.
  return parseRevisionDecisionJson(bytes);
}

// Compare each immutable field by exact value. Object key order is immaterial;
// worksheet view and row order are not. Unknown fields reject.
function matchFields(actual, expected, responses = []) {
  closed(actual, [...Object.keys(expected), ...responses]);
  for (const [key, value] of Object.entries(expected)) if (actual[key] !== value) fail();
}

function prepareRequest(family, expected, manifest, worksheet) {
  const original = family === 'original';
  closed(worksheet, ['schema', 'family', 'bindings', 'views', 'decision_id', 'reviewer_label', 'choice'], ['note']);
  const {decision_id, reviewer_label, choice} = worksheet;
  if (worksheet.schema !== 'SQUIRE_PROJECT_REVIEW_WORKSHEET_V1' || worksheet.family !== family ||
      typeof decision_id !== 'string' || !TOKEN.test(decision_id) ||
      typeof reviewer_label !== 'string' || !TOKEN.test(reviewer_label) ||
      !['ACCEPT', 'REVISE', 'REJECT'].includes(choice)) fail();
  if (Object.hasOwn(worksheet, 'note') &&
      !(typeof worksheet.note === 'string' && Buffer.byteLength(worksheet.note) <= 4096) &&
      !(!original && worksheet.note === null)) fail();

  const bindings = {base_commit: manifest.base_commit, base_tree: manifest.base_tree};
  const views = original
    ? [['base_to_candidate', 'diff.txt', manifest.paths, 'old', 'new']]
    : [['base_to_revised', 'base-to-revised.diff.txt', manifest.base_to_revised, 'base', 'revised'],
       ['original_to_revised', 'original-to-revised.diff.txt', manifest.original_to_revised, 'original', 'revised']];
  if (original) Object.assign(bindings, {
    review_package_sha256: expected, candidate_commit: manifest.candidate_commit, candidate_tree: manifest.candidate_tree,
  });
  else Object.assign(bindings, {
    revision_package_sha256: expected, original_package_sha256: manifest.original_package_sha256,
    prior_revise_decision_sha256: manifest.prior_revise_decision_sha256,
    original_commit: manifest.original_commit, original_tree: manifest.original_tree,
    revised_commit: manifest.revised_commit, revised_tree: manifest.revised_tree,
  });
  matchFields(worksheet.bindings, bindings);
  if (!Array.isArray(worksheet.views) || worksheet.views.length !== views.length) fail();
  const attestations = [];
  for (const [i, [view, display, rows, oldSuffix, newSuffix]] of views.entries()) {
    const actual = worksheet.views[i];
    matchFields(actual, {view, display}, ['paths']);
    if (!Array.isArray(actual.paths) || actual.paths.length !== rows.length) fail();
    for (const [j, row] of rows.entries()) {
      const endpoint = {path: row.path, old_sha256: row.old?.sha256 ?? null, new_sha256: row.new.sha256};
      const response = actual.paths[j];
      matchFields(response, {
        ...endpoint, old_copy: row.old ? `changes/${row.path}.${oldSuffix}` : null,
        new_copy: `changes/${row.path}.${newSuffix}`, binary_review_required: row.binary_review_required,
      }, ['attested', 'binary_inspected']);
      const {attested, binary_inspected} = response;
      if (![null, true, false].includes(attested) || ![null, true, false].includes(binary_inspected)) fail();
      if (attested !== true) {
        // No attestation can represent a binary claim without a path claim.
        if (choice === 'ACCEPT' || binary_inspected === true) fail();
        continue;
      }
      // Even a text row requires an explicit boolean; never fill a blank with
      // false. The existing recorder still owns the final request checks.
      if (typeof binary_inspected !== 'boolean' ||
          (choice === 'ACCEPT' && row.binary_review_required && !binary_inspected)) fail();
      attestations.push({...(!original && {view}), ...endpoint, binary_inspected});
    }
  }
  const key = item => original ? item.path : `${item.view}/${item.path}`;
  attestations.sort((a, b) => key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);
  const request = {
    schema: original ? 'SQUIRE_PROJECT_CANDIDATE_DECISION_V1' : 'SQUIRE_PROJECT_REVISION_DECISION_V1',
    decision_id, reviewer_label, ...bindings, choice, attestations,
    ...(Object.hasOwn(worksheet, 'note') && {note: worksheet.note}),
  };
  const bytes = Buffer.from(JSON.stringify(request, null, 2) + '\n');
  if (bytes.length > MAX_REVIEW_DECISION_BYTES) fail();
  return bytes;
}

async function writeRequest(destination, bytes) {
  await ancestors(fs, destination);
  const handle = await fs.open(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    const check = async size => {
      const opened = await handle.stat();
      const leaf = await fs.lstat(destination);
      if (!leaf.isFile() || leaf.uid !== process.getuid() || leaf.nlink !== 1 ||
          (leaf.mode & 0o7777) !== 0o600 || leaf.size !== size || !stable(opened, leaf)) fail();
    };
    await check(0);
    await handle.writeFile(bytes);
    await check(bytes.length);
  } finally {
    await handle.close();
  }
}

async function main(args) {
  if (args.length === 1 && args[0] === '--help') return process.stdout.write(usage);
  const [family, packageDir, expected, worksheetPath, destination] = args;
  if (args.length !== 5 || !['original', 'revision'].includes(family) ||
      ![packageDir, worksheetPath, destination].every(absolute) ||
      expected.length !== 64 || !/^[a-f0-9]{64}$/.test(expected) ||
      overlaps(packageDir, worksheetPath) || overlaps(packageDir, destination) || overlaps(worksheetPath, destination)) {
    process.exitCode = 2;
    return process.stderr.write(usage);
  }
  const manifest = await verifiedManifest(family, packageDir, expected);
  const worksheet = await readWorksheet(worksheetPath);
  await writeRequest(destination, prepareRequest(family, expected, manifest, worksheet));
  process.stdout.write('PROJECT_REVIEW_DECISION_REQUEST_PREPARED\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const outputError = () => { process.exitCode = 2; };
  process.stdout.on('error', outputError);
  process.stderr.on('error', outputError);
  try {
    await main(process.argv.slice(2));
  } catch {
    process.exitCode = 2;
    process.stderr.write('PROJECT_REVIEW_DECISION_REQUEST_REJECTED\n');
  }
}
