// Private first-revision review APIs; shared validation keeps live and retained paths aligned.
import {join} from 'node:path';
import {types} from 'node:util';
import {readProjectRevisionReviewSource} from './project-portable-candidate-snapshot.mjs';
import {planRevisionPackageSides,ReviewPackageError,invalid,rejected,aborted,digest,encode,plain,closed,denseArray,absolute,captureSignal,check,capturePort,file,dir,stable,stat,ancestors,missing,reserve,ensureDir,writeFile,readFile,asText,makeDiff,side,validPath,rowsFor,manifestFor,matchesKeys,validateSide,listPackage,verifyInternal,priorLinks,captureBuildSpec,SHA1,SHA256,TOKEN,PACKAGE_SCHEMA,DECISION_SCHEMA,MAX_SIDE,MAX_COPIES,MAX_DIFF,MAX_MANIFEST,MAX_PACKAGE,MAX_REVIEW_DECISION_BYTES,decoder} from './internal/revision-review-core.mjs';
export {verifyProjectRevisionReviewPackage} from './internal/revision-review-core.mjs';
export async function buildProjectRevisionReviewPackage(spec,ports={}){let signal;
  try{const fs=capturePort(ports);signal=captureBuildSpec(spec);check(signal);
    const sourceSpec={schema:spec.schema,original_result:spec.original_result,revised_result:spec.revised_result,
      base_git_dir:spec.base_git_dir,base_git_identity:spec.base_git_identity,
      original_git_dir:spec.original_git_dir,original_git_identity:spec.original_git_identity,
      revised_git_dir:spec.revised_git_dir,revised_git_identity:spec.revised_git_identity,
      output_dir:spec.output_dir,signal};
    const source=await readProjectRevisionReviewSource(sourceSpec,{fs});
    const links=await priorLinks(fs,spec,source,signal);
    const sides=planRevisionPackageSides(source.files);
    const displays={base:makeDiff(rowsFor(source.files,source.base_to_revised,'base'),'base'),
      original:makeDiff(rowsFor(source.files,source.original_to_revised,'original'),'original')};
    const manifest=manifestFor(source,links,displays),bytes=encode(manifest);
    if(bytes.length>MAX_MANIFEST||source.files.reduce((sum,row)=>sum+['base','original','revised'].reduce((n,k)=>n+(row[k]?.bytes??0),0),0)+
      displays.base.length+displays.original.length+bytes.length>MAX_PACKAGE)rejected();
    await reserve(fs,spec.output_dir,signal);await ensureDir(fs,spec.output_dir,'changes',signal);
    for(const side of sides)await writeFile(fs,spec.output_dir,side.path,side.data,signal);
    await writeFile(fs,spec.output_dir,'base-to-revised.diff.txt',displays.base,signal);
    await writeFile(fs,spec.output_dir,'original-to-revised.diff.txt',displays.original,signal);
    await writeFile(fs,spec.output_dir,'revision-review-manifest.json',bytes,signal);
    const again=await readProjectRevisionReviewSource(sourceSpec,{fs});
    const againLinks=await priorLinks(fs,spec,again,signal);
    const againDisplays={base:makeDiff(rowsFor(again.files,again.base_to_revised,'base'),'base'),
      original:makeDiff(rowsFor(again.files,again.original_to_revised,'original'),'original')};
    if(!encode(manifestFor(again,againLinks,againDisplays)).equals(bytes))rejected();
    const v=await verifyInternal(fs,spec.output_dir,signal);check(signal);
    return Object.freeze({status:'PROJECT_REVISION_REVIEW_PACKAGE_CREATED',manifest_sha256:v.manifest_sha256,
      base_commit:manifest.base_commit,original_commit:manifest.original_commit,revised_commit:manifest.revised_commit,
      base_to_revised_count:manifest.base_to_revised.length,original_to_revised_count:manifest.original_to_revised.length,
      package_bytes:v.package_bytes});
  }catch(e){if(e instanceof ReviewPackageError)throw e;if(signal?.aborted||e?.code==='PROJECT_PORTABLE_SNAPSHOT_ABORTED')aborted();
    if(e?.code==='INVALID_PROJECT_PORTABLE_SNAPSHOT_SPEC')invalid();rejected();}}
function captureDecision(value){closed(value,['schema','decision_id','reviewer_label','revision_package_sha256',
  'original_package_sha256','prior_revise_decision_sha256','base_commit','base_tree','original_commit','original_tree',
  'revised_commit','revised_tree','choice','attestations'],['note']);
  if(value.schema!==DECISION_SCHEMA||!TOKEN.test(value.decision_id)||!TOKEN.test(value.reviewer_label)||
    ['revision_package_sha256','original_package_sha256','prior_revise_decision_sha256'].some(k=>!SHA256.test(value[k]))||
    ['base_commit','base_tree','original_commit','original_tree','revised_commit','revised_tree'].some(k=>!SHA1.test(value[k]))||
    !['ACCEPT','REVISE','REJECT'].includes(value.choice)||
    (value.note!==undefined&&value.note!==null&&(typeof value.note!=='string'||Buffer.byteLength(value.note)>4096)))invalid();
  const attestations=[];let last='';for(const item of denseArray(value.attestations,100)){closed(item,['view','path','old_sha256','new_sha256','binary_inspected']);
    if(!['base_to_revised','original_to_revised'].includes(item.view)||!validPath(item.path)||
      (item.old_sha256!==null&&!SHA256.test(item.old_sha256))||!SHA256.test(item.new_sha256)||
      typeof item.binary_inspected!=='boolean'||`${item.view}/${item.path}`<=last)invalid();
    last=`${item.view}/${item.path}`;attestations.push({...item});}
  return {schema:DECISION_SCHEMA,decision_id:value.decision_id,reviewer_label:value.reviewer_label,
    revision_package_sha256:value.revision_package_sha256,original_package_sha256:value.original_package_sha256,
    prior_revise_decision_sha256:value.prior_revise_decision_sha256,
    base_commit:value.base_commit,base_tree:value.base_tree,original_commit:value.original_commit,original_tree:value.original_tree,
    revised_commit:value.revised_commit,revised_tree:value.revised_tree,choice:value.choice,attestations,note:value.note??null,
    boundaries:['REVIEWER_LABEL_NOT_AUTHENTICATED','SOURCE_DECISION_ONLY','NO_EXECUTION_OR_MERGE_AUTHORITY','NO_IMPLICIT_WINNER']};}
function validateDecision(d,v){const m=v.manifest;if(d.revision_package_sha256!==v.manifest_sha256||
  d.original_package_sha256!==m.original_package_sha256||d.prior_revise_decision_sha256!==m.prior_revise_decision_sha256||
  ['base_commit','base_tree','original_commit','original_tree','revised_commit','revised_tree'].some(k=>d[k]!==m[k]))rejected();
  for(const a of d.attestations){const row=m[a.view].find(v=>v.path===a.path);if(!row||a.old_sha256!==(row.old?.sha256??null)||
    a.new_sha256!==row.new.sha256||(d.choice==='ACCEPT'&&row.binary_review_required&&!a.binary_inspected))rejected();}
  if(d.choice==='ACCEPT'&&d.attestations.length!==m.base_to_revised.length+m.original_to_revised.length)rejected();}
async function verifyDecisionInternal(fs,packageDir,decisionDir,expectedSha256){if(!absolute(packageDir)||!absolute(decisionDir)||
  !SHA256.test(expectedSha256)||packageDir===decisionDir||packageDir.startsWith(decisionDir+'/')||decisionDir.startsWith(packageDir+'/'))invalid();
  const v=await verifyInternal(fs,packageDir,undefined);await ancestors(fs,decisionDir);const s=await stat(fs,decisionDir);
  if(!dir(s)||s.uid!==process.getuid()||(s.mode&0o7777)!==0o700||await fs.realpath(decisionDir)!==decisionDir||
    (await listPackage(fs,decisionDir,undefined)).join('|')!=='decision.json')rejected();
  const bytes=await readFile(fs,join(decisionDir,'decision.json'),MAX_REVIEW_DECISION_BYTES,undefined);let raw;
  try{raw=JSON.parse(decoder.decode(bytes));}catch{rejected();}
  if(digest(bytes)!==expectedSha256||!Buffer.from(encode(raw)).equals(bytes)||
    !matchesKeys(raw,['schema','decision_id','reviewer_label','revision_package_sha256','original_package_sha256',
      'prior_revise_decision_sha256','base_commit','base_tree','original_commit','original_tree','revised_commit','revised_tree',
      'choice','attestations','note','boundaries'])||!Array.isArray(raw.boundaries)||
    raw.boundaries.join('|')!=='REVIEWER_LABEL_NOT_AUTHENTICATED|SOURCE_DECISION_ONLY|NO_EXECUTION_OR_MERGE_AUTHORITY|NO_IMPLICIT_WINNER')rejected();
  let d;try{const {boundaries,...input}=raw;d=captureDecision(input);}catch(e){rejected();}
  if(!Buffer.from(encode(d)).equals(bytes))rejected();validateDecision(d,v);return {decision:d,decision_sha256:expectedSha256,verified:v};}
export async function verifyProjectRevisionDecision(revisionPackageDir,decisionDir,expectedSha256,ports={}){try{
  const v=await verifyDecisionInternal(capturePort(ports),revisionPackageDir,decisionDir,expectedSha256);
  return Object.freeze({status:'PROJECT_REVISION_DECISION_VERIFIED',choice:v.decision.choice,decision_sha256:v.decision_sha256,
    revision_package_sha256:v.verified.manifest_sha256,attested_path_count:v.decision.attestations.length});
  }catch(e){if(e instanceof ReviewPackageError)throw e;rejected();}}
export async function recordProjectRevisionDecision(revisionPackageDir,decision,freshDecisionDir,ports={}){try{
  const fs=capturePort(ports),d=captureDecision(decision);if(!absolute(freshDecisionDir)||!absolute(revisionPackageDir)||
    freshDecisionDir===revisionPackageDir||freshDecisionDir.startsWith(revisionPackageDir+'/')||revisionPackageDir.startsWith(freshDecisionDir+'/'))invalid();
  const v=await verifyInternal(fs,revisionPackageDir,undefined);validateDecision(d,v);const bytes=encode(d);if(bytes.length>MAX_REVIEW_DECISION_BYTES)invalid();
  await reserve(fs,freshDecisionDir,undefined);await writeFile(fs,freshDecisionDir,'decision.json',bytes,undefined);
  const checked=await verifyDecisionInternal(fs,revisionPackageDir,freshDecisionDir,digest(bytes));
  return Object.freeze({status:'PROJECT_REVISION_DECISION_RECORDED',choice:d.choice,decision_sha256:checked.decision_sha256,
    revision_package_sha256:v.manifest_sha256,attested_path_count:d.attestations.length});
  }catch(e){if(e instanceof ReviewPackageError)throw e;rejected();}}

export {buildProjectRevisionReviewPackageFromRetainedSource} from './project-retained-revision-review-source.mjs';
