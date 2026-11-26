// Compose exact builder specs without inspecting Git or creating a candidate/package.
import * as fs from 'node:fs/promises';
import {constants} from 'node:fs';
import {basename,dirname,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {readReceiptBytes} from './squire-report.mjs';
import {parseReceiptJson} from '../src/offline-run-summary.mjs';
import {validateProjectReviewResultWitnesses} from '../src/project-portable-candidate-snapshot.mjs';
import {absolute,ancestors,closed,digest,readFile,stable,missing,captureBuildSpec}
  from '../src/internal/revision-review-core.mjs';
import {MAX_REVIEW_DECISION_BYTES} from '../src/project-review-decision-limits.mjs';

const usage = 'Usage: node bin/squire-review-spec.mjs <original|revision> <bindings.json> <fresh-spec.json>\n';
const ORIGINAL = 'SQUIRE_PROJECT_CANDIDATE_REVIEW_SPEC_V1';
const REVISION = 'SQUIRE_PROJECT_REVISION_REVIEW_SPEC_V1';
const MAX_ORIGINAL = 65536, MAX_REVISION = 262144;
const sha256 = v => typeof v === 'string' && v.length === 64 && /^[a-f0-9]{64}$/.test(v);
const token = v => typeof v === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(v);
const overlap = (a,b) => a === b || a.startsWith(b + '/') || b.startsWith(a + '/');
const reject = () => { throw new Error('Rejected'); };

async function readJson(path, limit) {
  if (!absolute(path)) reject();
  await ancestors(fs,path);
  const before = await fs.lstat(path);
  const bytes = await readReceiptBytes(path,limit);
  const after = await fs.lstat(path);
  if (!after.isFile() || !stable(before,after)) reject();
  return parseReceiptJson(bytes);
}

function identity(value) {
  closed(value,['dev','ino']);
  if (![value.dev,value.ino].every(n => Number.isSafeInteger(n) && n >= 0)) reject();
}

function disjoint(paths) {
  if (paths.some(p => !absolute(p))) reject();
  for (let i=0;i<paths.length;i++) {
    for (let j=i+1;j<paths.length;j++) if (overlap(paths[i],paths[j])) reject();
  }
}

// Only explicitly declared records are read. Their package/attestation and
// source bindings remain subject to the existing full downstream verifier.
async function checkPriorReferences(spec) {
  if (!sha256(spec.original_package.manifest_sha256) || !token(spec.selected_decision_id)) reject();
  const ids = new Set();
  for (const reference of spec.prior_decisions) {
    if (!sha256(reference.file_sha256)) reject();
    const bytes = await readFile(fs,join(reference.dir,'decision.json'),MAX_REVIEW_DECISION_BYTES);
    if (digest(bytes) !== reference.file_sha256) reject();
    const record = parseReceiptJson(bytes);
    if (record.schema !== 'SQUIRE_PROJECT_CANDIDATE_DECISION_V1' ||
        !token(record.decision_id) || ids.has(record.decision_id) || record.choice !== 'REVISE' ||
        record.review_package_sha256 !== spec.original_package.manifest_sha256 ||
        ['base_commit','base_tree','candidate_commit','candidate_tree']
          .some(k => record[k] !== spec.original_result[k])) reject();
    ids.add(record.decision_id);
  }
  if (!ids.has(spec.selected_decision_id)) reject();
}

async function compose(family, bindingsPath, destination) {
  const revision = family === 'revision';
  const limit = revision ? MAX_REVISION : MAX_ORIGINAL;
  const bindings = await readJson(bindingsPath,limit);
  const stores = revision ? ['base','original','revised'] : ['base','candidate'];
  const storeKeys = stores.flatMap(k => [k+'_git_dir',k+'_git_identity']);
  const resultKeys = revision ? ['original_result','revised_result'] : ['result'];
  const referenceKeys = revision ? ['original_package','prior_decisions','selected_decision_id'] : [];
  closed(bindings,[...storeKeys,...resultKeys.map(k => k+'_file'),'output_dir',...referenceKeys]);
  for (const k of stores) {
    if (!absolute(bindings[k+'_git_dir']) || (k !== 'base' && basename(bindings[k+'_git_dir']) === '.git')) reject();
    identity(bindings[k+'_git_identity']);
  }
  const spec = {schema: revision ? REVISION : ORIGINAL};
  for (const k of [...storeKeys,'output_dir',...referenceKeys]) spec[k] = bindings[k];
  // The existing builder's closed shape check needs both result fields present.
  for (const key of resultKeys) spec[key] = null;
  if (revision) captureBuildSpec(spec);
  const base = bindings.base_git_dir;
  const protectedBase = basename(base) === '.git' ? dirname(base) : base;
  const roots = [protectedBase,...stores.slice(1).map(k => bindings[k+'_git_dir']),spec.output_dir];
  if (revision) roots.push(spec.original_package.dir,...spec.prior_decisions.map(v => v.dir));
  const selections = [bindingsPath,...resultKeys.map(k => bindings[k+'_file']),destination];
  disjoint([...roots,...selections]);
  // Only the two output destinations are checked for vacancy; the source-store
  // paths and identities remain exactly as supplied, without Git/filesystem reads.
  await ancestors(fs,destination);
  await ancestors(fs,spec.output_dir);
  if (!await missing(fs,destination) || !await missing(fs,spec.output_dir)) reject();
  for (const key of resultKeys) spec[key] = await readJson(bindings[key+'_file'],MAX_ORIGINAL);
  if (revision) {
    validateProjectReviewResultWitnesses(spec.original_result,spec.revised_result);
    await checkPriorReferences(spec);
  } else {
    validateProjectReviewResultWitnesses(spec.result);
  }
  const bytes = Buffer.from(JSON.stringify(spec)+'\n');
  if (bytes.length > limit) reject();
  return {bytes,outputDir:spec.output_dir};
}

async function writeSpec(destination,bytes,outputDir) {
  await ancestors(fs,destination);
  if (!await missing(fs,outputDir)) reject();
  const handle = await fs.open(destination,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
  try {
    const check = async size => {
      const opened = await handle.stat(), leaf = await fs.lstat(destination);
      if (!leaf.isFile() || leaf.uid !== process.getuid() || leaf.nlink !== 1 ||
          (leaf.mode & 0o7777) !== 0o600 || leaf.size !== size || !stable(opened,leaf)) reject();
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
  const [family,bindings,destination] = args;
  if (args.length !== 3 || !['original','revision'].includes(family) ||
      !absolute(bindings) || !absolute(destination) || overlap(bindings,destination)) {
    process.exitCode = 2;
    return process.stderr.write(usage);
  }
  const {bytes,outputDir} = await compose(family,bindings,destination);
  await writeSpec(destination,bytes,outputDir);
  process.stdout.write('PROJECT_REVIEW_SPEC_COMPOSED\n');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const outputError = () => { process.exitCode = 2; };
  process.stdout.on('error',outputError);
  process.stderr.on('error',outputError);
  try { await main(process.argv.slice(2)); }
  catch {
    process.exitCode = 2;
    process.stderr.write('PROJECT_REVIEW_SPEC_REJECTED\n');
  }
}
