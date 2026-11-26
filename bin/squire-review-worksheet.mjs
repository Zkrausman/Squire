// Prepare an editable checklist for a single digest-bound package.
import {constants} from 'node:fs';
import * as fs from 'node:fs/promises';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {verifyProjectCandidateReviewPackage} from '../src/project-candidate-review-package.mjs';
import {absolute, ancestors, digest, readFile, stable, verifyInternal as verifyRevision}
  from '../src/internal/revision-review-core.mjs';

const usage = 'Usage: node bin/squire-review-worksheet.mjs <original|revision> <package-dir> <expected-manifest-sha256> <fresh-worksheet.json>\n';

async function verifiedManifest(family, packageDir, expected) {
  if (family === 'revision') return (await verifyRevision(fs, packageDir, undefined, expected)).manifest;
  await verifyProjectCandidateReviewPackage(packageDir, {}, expected);
  // The original public verifier returns only a summary. Bind the bounded reread
  // to the same verified bytes before using any field to prepare the worksheet.
  const bytes = await readFile(fs, join(packageDir, 'review-manifest.json'), 256 * 1024);
  if (digest(bytes) !== expected) throw new Error('Manifest changed');
  return JSON.parse(bytes.toString('utf8'));
}

function view(name, display, paths, oldSuffix, newSuffix) {
  return {
    view: name,
    display,
    paths: paths.map(row => ({
      path: row.path,
      old_copy: row.old ? `changes/${row.path}.${oldSuffix}` : null,
      old_sha256: row.old?.sha256 ?? null,
      new_copy: `changes/${row.path}.${newSuffix}`,
      new_sha256: row.new.sha256,
      binary_review_required: row.binary_review_required,
      attested: null,
      binary_inspected: null,
    })),
  };
}

function worksheet(family, expected, manifest) {
  const bindings = {base_commit: manifest.base_commit, base_tree: manifest.base_tree};
  let views;
  if (family === 'original') {
    Object.assign(bindings, {
      review_package_sha256: expected,
      candidate_commit: manifest.candidate_commit,
      candidate_tree: manifest.candidate_tree,
    });
    views = [view('base_to_candidate', 'diff.txt', manifest.paths, 'old', 'new')];
  } else {
    Object.assign(bindings, {
      revision_package_sha256: expected,
      original_package_sha256: manifest.original_package_sha256,
      prior_revise_decision_sha256: manifest.prior_revise_decision_sha256,
      original_commit: manifest.original_commit,
      original_tree: manifest.original_tree,
      revised_commit: manifest.revised_commit,
      revised_tree: manifest.revised_tree,
    });
    views = [
      view('base_to_revised', 'base-to-revised.diff.txt', manifest.base_to_revised, 'base', 'revised'),
      view('original_to_revised', 'original-to-revised.diff.txt', manifest.original_to_revised, 'original', 'revised'),
    ];
  }
  return {
    schema: 'SQUIRE_PROJECT_REVIEW_WORKSHEET_V1',
    family, bindings, views,
    decision_id: null, reviewer_label: null, choice: null,
  };
}

async function writeWorksheet(destination, document) {
  const bytes = Buffer.from(JSON.stringify(document, null, 2) + '\n');
  await ancestors(fs, destination);
  const handle = await fs.open(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    const check = async size => {
      const opened = await handle.stat();
      const leaf = await fs.lstat(destination);
      if (!leaf.isFile() || leaf.uid !== process.getuid() || leaf.nlink !== 1 ||
          (leaf.mode & 0o7777) !== 0o600 || leaf.size !== size || !stable(opened, leaf)) {
        throw new Error('Worksheet changed');
      }
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
  const [family, packageDir, expected, destination] = args;
  if (args.length !== 4 || !['original', 'revision'].includes(family) ||
      !absolute(packageDir) || !absolute(destination) || expected.length !== 64 || !/^[a-f0-9]{64}$/.test(expected) ||
      destination === packageDir || destination.startsWith(packageDir + '/') || packageDir.startsWith(destination + '/')) {
    process.exitCode = 2;
    return process.stderr.write(usage);
  }
  const manifest = await verifiedManifest(family, packageDir, expected);
  await writeWorksheet(destination, worksheet(family, expected, manifest));
  process.stdout.write('PROJECT_REVIEW_WORKSHEET_PREPARED\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const outputError = () => { process.exitCode = 2; };
  process.stdout.on('error', outputError);
  process.stderr.on('error', outputError);
  try {
    await main(process.argv.slice(2));
  } catch {
    process.exitCode = 2;
    process.stderr.write('PROJECT_REVIEW_WORKSHEET_REJECTED\n');
  }
}
