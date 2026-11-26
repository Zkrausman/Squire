// Collect explicit keyboard responses into a new worksheet, not a decision.
import * as fs from 'node:fs/promises';
import {createInterface} from 'node:readline';
import {pathToFileURL} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import {absolute, ancestors, TOKEN} from '../src/internal/revision-review-core.mjs';
import {readWorksheet} from './squire-review-decision-request.mjs';
import {verifiedManifest, worksheet, writeWorksheet} from './squire-review-worksheet.mjs';

const usage = 'Usage: node bin/squire-review-response.mjs <original|revision> <package-dir> <expected-manifest-sha256> <blank-worksheet.json> <fresh-completed-worksheet.json>\n';
const fail = () => { throw new Error('Invalid review response session'); };
const overlaps = (a, b) => a === b || a.startsWith(b + '/') || b.startsWith(a + '/');
const selections = ['ACCEPT', 'REVISE', 'REJECT'];
const boolean = value => value === '' ? null : value === 'yes';
const booleanAnswer = value => ['', 'yes', 'no'].includes(value);
const identityAnswer = value => value === '' || TOKEN.test(value);
const emit = text => new Promise((resolve, reject) => {
  process.stdout.write(text, error => error ? reject(error) : resolve());
});

async function verifiedBlank(family, packageDir, expected, blankPath) {
  const manifest = await verifiedManifest(family, packageDir, expected);
  const blank = await readWorksheet(blankPath);
  // The producer's projection is the exact contract (including every null
  // response), not arbitrary rows from an editable file.
  if (!isDeepStrictEqual(structuredClone(blank), worksheet(family, expected, manifest))) fail();
  return blank;
}

async function collect(blank, packageDir, expected) {
  const result = structuredClone(blank);
  const input = createInterface({input: process.stdin, terminal: false, crlfDelay: Infinity});
  const lines = input[Symbol.asyncIterator]();
  async function ask(prompt, accepts) {
    for (;;) {
      await emit(prompt + '\n');
      const {value, done} = await lines.next();
      if (done) fail();
      if (accepts(value)) return value;
      await emit('Invalid response; enter one of the indicated values.\n');
    }
  }
  try {
    await emit(`Selected package: ${JSON.stringify(packageDir)}\nManifest SHA-256: ${expected}\n` +
      'Inspect the exact evidence in a separate local viewer. Reading evidence does not set responses.\n' +
      'Enter yes, no, or a blank line to leave each response unset.\n');
    result.choice = (await ask('Choice [ACCEPT/REVISE/REJECT/blank]', value => value === '' || selections.includes(value))) || null;
    const leaveUnset = (result.choice === 'REVISE' || result.choice === 'REJECT') &&
      (await ask('Row responses [rows=answer individually/unset=leave all row responses unset]', value => ['rows', 'unset'].includes(value))) === 'unset';
    for (const view of result.views) {
      await emit(`\nView: ${view.view}\nDisplay: ${JSON.stringify(view.display)}\n`);
      for (const row of view.paths) {
        await emit(`\nPath: ${JSON.stringify(row.path)}\n` +
          `Old copy: ${JSON.stringify(row.old_copy)}\nOld SHA-256: ${row.old_sha256}\n` +
          `New copy: ${JSON.stringify(row.new_copy)}\nNew SHA-256: ${row.new_sha256}\n` +
          `Binary review required: ${row.binary_review_required}\n`);
        if (!leaveUnset) {
          row.attested = boolean(await ask('Attest this exact comparison? [yes/no/blank]', booleanAnswer));
          row.binary_inspected = boolean(await ask('Binary inspected for this exact comparison? [yes/no/blank]', booleanAnswer));
        }
      }
    }
    if (leaveUnset) await emit('All row responses remain unset; no attestation or binary inspection is claimed.\n');
    result.decision_id = (await ask('Decision ID [letters/digits/_/- or blank; 1–64 characters]', identityAnswer)) || null;
    result.reviewer_label = (await ask('Reviewer label [letters/digits/_/- or blank; 1–64 characters]', identityAnswer)) || null;
    const note = await ask('Optional note [single line, at most 4096 UTF-8 bytes; blank to omit]', value => Buffer.byteLength(value) <= 4096);
    if (note !== '') result.note = note;
    const save = await ask('Save a fresh worksheet only? [yes/no]', value => ['yes', 'no'].includes(value));
    if (save !== 'yes') fail();
    return result;
  } finally {
    input.close();
  }
}

async function main(args) {
  if (args.length === 1 && args[0] === '--help') return emit(usage);
  const [family, packageDir, expected, blankPath, destination] = args;
  if (args.length !== 5 || !['original', 'revision'].includes(family) ||
      ![packageDir, blankPath, destination].every(absolute) || !/^[a-f0-9]{64}$/.test(expected) ||
      overlaps(packageDir, blankPath) || overlaps(packageDir, destination) || overlaps(blankPath, destination)) {
    process.exitCode = 2;
    return process.stderr.write(usage);
  }
  await ancestors(fs, destination);
  try {
    await fs.lstat(destination);
    fail();
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const blank = await verifiedBlank(family, packageDir, expected, blankPath);
  const completed = await collect(blank, packageDir, expected);
  // Check the selected inputs again after the potentially long human session.
  await verifiedBlank(family, packageDir, expected, blankPath);
  await writeWorksheet(destination, completed);
  await emit('PROJECT_REVIEW_RESPONSE_SAVED\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const outputError = () => { process.exitCode = 2; };
  process.stdout.on('error', outputError);
  process.stderr.on('error', outputError);
  try {
    await main(process.argv.slice(2));
  } catch {
    process.exitCode = 2;
    process.stderr.write('PROJECT_REVIEW_RESPONSE_STOPPED; PRESERVE_OUTPUT_IF_ANY\n');
  }
}
