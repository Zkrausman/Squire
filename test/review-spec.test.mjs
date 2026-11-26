import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {fixture} from './helpers/revision-review-fixture.mjs';
import {recordProjectCandidateDecision} from '../src/project-candidate-review-package.mjs';

const compose = fileURLToPath(new URL('../bin/squire-review-spec.mjs',import.meta.url));
const build = fileURLToPath(new URL('../bin/squire-candidate-review.mjs',import.meta.url));
const run = (cli,args) => {
  const r = spawnSync(process.execPath,[cli,...args],{encoding:'utf8',timeout:30000,maxBuffer:65536});
  assert.equal(r.error,undefined);
  assert.equal(r.signal,null);
  return r;
};
const json = async (path,v) => fs.writeFile(path,JSON.stringify(v)+'\n',{mode:0o600});
const read = async path => JSON.parse(await fs.readFile(path,'utf8'));
const absent = path => assert.rejects(fs.lstat(path),{code:'ENOENT'});
const accepted = r => {
  assert.equal(r.status,0,r.stderr);
  assert.equal(r.stdout,'PROJECT_REVIEW_SPEC_COMPOSED\n');
  assert.equal(r.stderr,'');
};
const rejected = r => {
  assert.equal(r.status,2);
  assert.equal(r.stdout,'');
  assert.equal(r.stderr,'PROJECT_REVIEW_SPEC_REJECTED\n');
};

async function setup(t) {
  const f = await fixture();
  t.after(() => fs.rm(f.root,{recursive:true,force:true}));
  const file = name => join(f.root,name);
  const originalFile = file('saved-original.json'), revisedFile = file('saved-revised.json');
  await json(originalFile,f.originalResult);
  await json(revisedFile,f.revisedResult);
  const original = {
    result_file:originalFile,base_git_dir:f.spec.base_git_dir,base_git_identity:f.spec.base_git_identity,
    candidate_git_dir:f.spec.original_git_dir,candidate_git_identity:f.spec.original_git_identity,
    output_dir:file('composed-original-package'),
  };
  const {schema,original_result,revised_result,...rest} = f.spec;
  const revision = {...rest,original_result_file:originalFile,revised_result_file:revisedFile};
  const bindings = file('bindings.json'), destination = file('composed-spec.json');
  async function attempt(family,input,output=destination) {
    await json(bindings,input);
    return run(compose,[family,bindings,output]);
  }
  return {...f,file,originalFile,revisedFile,original,revision,bindings,destination,attempt};
}

test('original and first revision specs are accepted unchanged by existing build and verify CLIs',async t => {
  const f = await setup(t);
  const originalBytes = await fs.readFile(f.originalFile), revisedBytes = await fs.readFile(f.revisedFile);
  const priorBytes = await fs.readFile(join(f.revision.prior_decisions[0].dir,'decision.json'));
  accepted(await f.attempt('original',f.original));
  const {result_file,...originalBindings}=f.original;
  assert.deepEqual(await read(f.destination),{schema:'SQUIRE_PROJECT_CANDIDATE_REVIEW_SPEC_V1',result:f.originalResult,...originalBindings});
  assert.equal((await fs.stat(f.destination)).mode & 0o777,0o600);
  await absent(f.original.output_dir);
  const originalBuild = run(build,['--build',f.destination]);
  assert.equal(originalBuild.status,0,originalBuild.stderr);
  assert.match(originalBuild.stdout,/PROJECT_CANDIDATE_REVIEW_PACKAGE_CREATED/);
  const originalDigest = originalBuild.stdout.match(/Manifest SHA256: ([a-f0-9]{64})/)[1];
  assert.equal(originalDigest,f.p1.manifest_sha256);
  assert.equal(run(build,['--verify',f.original.output_dir,'--expect-sha256',originalDigest]).status,0);

  const revisionSpec = f.file('revision-spec.json');
  accepted(await f.attempt('revision',f.revision,revisionSpec));
  assert.deepEqual(await read(revisionSpec),f.spec);
  await absent(f.revision.output_dir);
  const revisionBuild = run(build,['--build-revision',revisionSpec]);
  assert.equal(revisionBuild.status,0,revisionBuild.stderr);
  const digest = revisionBuild.stdout.match(/Manifest SHA256: ([a-f0-9]{64})/)[1];
  assert.equal(run(build,['--verify-revision',f.revision.output_dir,'--expect-sha256',digest]).status,0);
  const manifest = await read(join(f.revision.output_dir,'revision-review-manifest.json'));
  assert.equal(manifest.original_to_revised.find(x=>x.path==='src/restore.mjs').classification,'RESTORED_BASE');
  assert.equal(manifest.original_to_revised.find(x=>x.path==='assets/icon.bin').binary_review_required,true);
  assert.equal(manifest.prior_revise_decision_sha256,f.prior.decision_sha256);
  assert.deepEqual(await fs.readFile(f.originalFile),originalBytes);
  assert.deepEqual(await fs.readFile(f.revisedFile),revisedBytes);
  assert.deepEqual(await fs.readFile(join(f.revision.prior_decisions[0].dir,'decision.json')),priorBytes);
});

test('composer does not open source stores; the builder still rejects nonexistent or wrong identities',async t => {
  const f = await setup(t);
  const input={...f.original,base_git_dir:f.file('absent-base.git'),candidate_git_dir:f.file('absent-candidate.git')};
  accepted(await f.attempt('original',input));
  assert.equal(run(build,['--build',f.destination]).status,2);
  await absent(input.output_dir);
  const revisionSpec = f.file('revision-spec.json');
  accepted(await f.attempt('revision',{...f.revision,revised_git_identity:{dev:1,ino:1}},revisionSpec));
  assert.equal(run(build,['--build-revision',revisionSpec]).status,2);
  await absent(f.revision.output_dir);
});

test('explicit selection and order of declared prior REVISE records are preserved; conflicting choices reject',async t => {
  const f=await setup(t);
  const witness=f.originalResult;
  async function record(id,choice) {
    const dir=f.file(id);
    const d=await recordProjectCandidateDecision(f.revision.original_package.dir,{
      schema:'SQUIRE_PROJECT_CANDIDATE_DECISION_V1',decision_id:id,reviewer_label:'fixture',
      review_package_sha256:f.p1.manifest_sha256,
      base_commit:witness.base_commit,base_tree:witness.base_tree,
      candidate_commit:witness.candidate_commit,candidate_tree:witness.candidate_tree,
      choice,attestations:[],
    },dir);
    return {dir,file_sha256:d.decision_sha256};
  }
  const another=await record('another','REVISE');
  const conflict=await record('conflict','REJECT');
  const input={...f.revision,prior_decisions:[...f.revision.prior_decisions,another]};
  accepted(await f.attempt('revision',input));
  const composed=await read(f.destination);
  assert.deepEqual(composed.prior_decisions,input.prior_decisions);
  assert.equal(composed.selected_decision_id,f.revision.selected_decision_id);
  const built=run(build,['--build-revision',f.destination]);
  assert.equal(built.status,0,built.stderr);
  const manifest=await read(join(input.output_dir,'revision-review-manifest.json'));
  assert.equal(manifest.prior_revise_decision_sha256,f.prior.decision_sha256);
  const output=f.file('conflicting-package'), spec=f.file('conflicting-spec.json');
  rejected(await f.attempt('revision',{...input,output_dir:output,prior_decisions:[...input.prior_decisions,conflict]},spec));
  await absent(spec);
  await absent(output);
});

test('wrong family, altered lineage, missing bindings and explicit prior references reject without output',async t => {
  const f = await setup(t);
  const bad = [
    ['original',{...f.original,result_file:f.revisedFile}],
    ['original',{...f.original,base_git_identity:{dev:1}}],
    ['original',{...f.original,output_dir:'relative'}],
    ['original',{...f.original,signal:null}],
    ['revision',{...f.revision,revised_result_file:f.originalFile}],
    ['revision',{...f.revision,prior_decisions:[]}],
    ['revision',{...f.revision,prior_decisions:[...f.revision.prior_decisions,...f.revision.prior_decisions]}],
    ['revision',{...f.revision,selected_decision_id:'missing'}],
    ['revision',{...f.revision,original_package:{...f.revision.original_package,manifest_sha256:'0'.repeat(64)}}],
    ['revision',{...f.revision,prior_decisions:[{...f.revision.prior_decisions[0],file_sha256:'0'.repeat(64)}]}],
  ];
  for(const [family,input] of bad) {
    rejected(await f.attempt(family,input));
    await absent(f.destination);
  }
  for (const changed of [
    {...f.revisedResult,receipt_sha256:'f'.repeat(64)},
    {...f.revisedResult,revision_of:{...f.revisedResult.revision_of,commit:'f'.repeat(40)}},
    {...f.revisedResult,revised_blobs:f.revisedResult.revised_blobs.map((v,i)=>i===0?{...v,sha256:[v.sha256]}:v)},
  ]) {
    await json(f.revisedFile,changed);
    rejected(await f.attempt('revision',f.revision));
    await absent(f.destination);
  }
  await absent(f.original.output_dir);
  await absent(f.revision.output_dir);
});

test('malformed, duplicate, oversize or linked inputs and occupied outputs fail closed',async t => {
  const f = await setup(t);
  for (const bytes of ['{"schema":"x","schema":"y"}',Buffer.from([255]),'{',Buffer.alloc(65537,32)]) {
    await fs.writeFile(f.originalFile,bytes);
    rejected(await f.attempt('original',f.original));
    await absent(f.destination);
  }
  await json(f.originalFile,f.originalResult);
  const link=f.file('link.json');await fs.symlink(f.originalFile,link);
  rejected(await f.attempt('original',{...f.original,result_file:link}));
  await absent(f.destination);
  await fs.writeFile(f.bindings,Buffer.alloc(65537,32));
  rejected(run(compose,['original',f.bindings,f.destination]));
  await absent(f.destination);
  await fs.writeFile(f.bindings,Buffer.alloc(262145,32));
  rejected(run(compose,['revision',f.bindings,f.destination]));
  await absent(f.destination);
  await fs.writeFile(f.destination,'keep');
  rejected(await f.attempt('original',f.original));
  assert.equal(await fs.readFile(f.destination,'utf8'),'keep');
  const linkedOutput=f.file('linked-output.json');
  await fs.symlink(f.destination,linkedOutput);
  rejected(await f.attempt('original',f.original,linkedOutput));
  assert.equal(await fs.readFile(f.destination,'utf8'),'keep');
  assert.equal((await fs.lstat(linkedOutput)).isSymbolicLink(),true);
  await fs.mkdir(f.original.output_dir);
  const alternate=f.file('another-spec.json');
  rejected(await f.attempt('original',f.original,alternate));
  await absent(alternate);
  assert.deepEqual(await fs.readdir(f.original.output_dir),[]);
});

test('inert help/import does not touch inputs',()=>{
  const help=run(compose,['--help']);
  assert.equal(help.status,0);
  assert.match(help.stdout,/Usage:/);
  const r=spawnSync(process.execPath,['--input-type=module','--eval',
    'const before=process.stdout.listenerCount("error"); await import('+JSON.stringify(new URL('../bin/squire-review-spec.mjs',import.meta.url).href)+'); if(process.stdout.listenerCount("error")!==before)process.exit(1);'],
    {encoding:'utf8',timeout:10000});
  assert.equal(r.status,0,r.stderr);
  assert.equal(r.stdout,'');
});
