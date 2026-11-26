// Prepare a private corrections array; never create a candidate or decision.
import {constants} from 'node:fs';
import * as fs from 'node:fs/promises';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {verifyProjectCandidateReviewPackage} from '../src/project-candidate-review-package.mjs';
import {absolute, ancestors, digest, readFile, stable} from '../src/internal/revision-review-core.mjs';

const usage = 'Usage: node bin/squire-corrections-draft.mjs <standard|large> <original-package-dir> <expected-manifest-sha256> <fresh-draft.json> <path> <replacement-file> [<path> <replacement-file> ...]\n';
const sideLimit = 512 * 1024;
const specLimit = 64 * 1024;
const overlap = (a, b) => a === b || a.startsWith(b + '/') || b.startsWith(a + '/');
const reject = () => { throw new Error('Corrections draft rejected'); };

async function writeDraft(destination, bytes) {
  await ancestors(fs, destination);
  const handle = await fs.open(destination, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    async function check(size) {
      const opened = await handle.stat();
      const leaf = await fs.lstat(destination);
      if (!leaf.isFile() || leaf.uid !== process.getuid() || leaf.nlink !== 1 ||
          (leaf.mode & 0o7777) !== 0o600 || leaf.size !== size || !stable(opened, leaf)) reject();
    }
    await check(0);
    await handle.writeFile(bytes);
    await check(bytes.length);
    const readback = Buffer.alloc(bytes.length);
    const {bytesRead} = await handle.read(readback, 0, readback.length, 0);
    if (bytesRead !== bytes.length || !readback.equals(bytes)) reject();
    await check(bytes.length);
  } finally {
    await handle.close();
  }
}

async function main(args) {
  if (args.length === 1 && args[0] === '--help') return process.stdout.write(usage);
  const [profile, packageDir, expected, destination, ...pairs] = args;
  if (pairs.length < 2 || pairs.length > 100 || pairs.length % 2 ||
      !['standard', 'large'].includes(profile) || !absolute(packageDir) || !absolute(destination) ||
      expected.length !== 64 || !/^[a-f0-9]{64}$/.test(expected) || overlap(packageDir, destination)) {
    process.exitCode = 2;
    return process.stderr.write(usage);
  }
  const selected = new Map();
  for (let i = 0; i < pairs.length; i += 2) {
    const [path, replacement] = pairs.slice(i, i + 2);
    if (selected.has(path) || !absolute(replacement) || overlap(packageDir, replacement) ||
        overlap(destination, replacement)) reject();
    selected.set(path, replacement);
  }

  // Verify all package bytes first; the public API returns a summary only.
  // Reread just the bounded manifest and match the same caller-retained digest.
  await verifyProjectCandidateReviewPackage(packageDir, {}, expected);
  const manifestBytes = await readFile(fs, join(packageDir, 'review-manifest.json'), 256 * 1024);
  if (digest(manifestBytes) !== expected) reject();
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  const rows = manifest.paths.filter(row => selected.has(row.path));
  if (rows.length !== selected.size || rows.some(row => row.new.bytes > sideLimit)) reject();
  const corrections = [];
  let remaining = profile === 'standard' ? 1024 * 1024 : 4 * 1024 * 1024;
  for (const {path, new: side} of rows) {
    const content_path = selected.get(path);
    const bytes = await readFile(fs, content_path, Math.min(sideLimit, remaining));
    try {
      if (bytes.length === side.bytes && digest(bytes) === side.sha256) reject();
      remaining -= bytes.length;
      corrections.push({path, original: {blob: side.git_sha1, bytes: side.bytes, sha256: side.sha256}, content_path});
    } finally {
      bytes.fill(0);
    }
  }
  const draft = Buffer.from(JSON.stringify(corrections, null, 2) + '\n');
  if (draft.length > specLimit) reject();
  await writeDraft(destination, draft);
  process.stdout.write('PROJECT_CORRECTIONS_DRAFT_PREPARED\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const outputError = () => { process.exitCode = 2; };
  process.stdout.on('error', outputError);
  process.stderr.on('error', outputError);
  try {
    await main(process.argv.slice(2));
  } catch {
    process.exitCode = 2;
    process.stderr.write('PROJECT_CORRECTIONS_DRAFT_REJECTED\n');
  }
}
