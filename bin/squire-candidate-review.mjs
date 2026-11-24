// Explicit offline original/first-revision package build/verification only; import is inert.
import {pathToFileURL} from 'node:url';
import {resolve,parse} from 'node:path';
import {types} from 'node:util';
import {closed} from '../src/job-spec.mjs';
import {parseReceiptJson} from '../src/offline-run-summary.mjs';
import {readReceiptBytes} from './squire-report.mjs';
import {buildProjectCandidateReviewPackage,verifyProjectCandidateReviewPackage,buildProjectCandidateReviewPackageFromSnapshot,verifyProjectCandidateReviewSnapshotHandoff} from '../src/project-candidate-review-package.mjs';
import {buildProjectRevisionReviewPackage,verifyProjectRevisionReviewPackage} from '../src/project-revision-review-package.mjs';

import {buildProjectRetainedRevisionReviewSource,verifyProjectRetainedRevisionReviewSource,buildProjectRevisionReviewPackageFromRetainedSource} from '../src/project-retained-revision-review-source.mjs';

const USAGE='Usage: node bin/squire-candidate-review.mjs <--build|--verify> <spec.json|package-dir>\n       node bin/squire-candidate-review.mjs <--build-revision|--verify-revision> <spec.json|package-dir>\n       node bin/squire-candidate-review.mjs <--verify|--verify-revision> <package-dir> --expect-sha256 <expected-manifest-sha256>\n       node bin/squire-candidate-review.mjs --build-from-snapshot <spec.json>\n       node bin/squire-candidate-review.mjs --verify-snapshot-handoff <handoff-dir> <expected-provenance-sha256>\n';
const RETAINED_USAGE='       node bin/squire-candidate-review.mjs --retain-revision-source <spec.json> | --verify-retained-revision-source <source-dir> <expected-manifest-sha256> | --build-revision-from-retained <spec.json>\n';
const REJECTED='PROJECT_CANDIDATE_REVIEW_REJECTED\n';
const MAX_SPEC_BYTES=65536,MAX_REVISION_SPEC_BYTES=262144;
const SHA256=/^[a-f0-9]{64}$/,SHA1=/^[a-f0-9]{40}$/;
const OBJECTS=['base_commit','base_tree','candidate_commit','candidate_tree'];
const byteLength=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype),'byteLength').get;
const absolute=v=>typeof v==='string'&&v.length>1&&v.length<=4096&&v.startsWith('/')&&resolve(v)===v&&v!==parse(v).root&&!/[\\\u0000-\u001f\u007f]/u.test(v);

function revisionLines(result,spec,verify,expected){
  const status=result?.status,manifest=result?.manifest_sha256;
  const commits=[result?.base_commit,result?.original_commit,result?.revised_commit];
  const baseCount=result?.base_to_revised_count,originalCount=result?.original_to_revised_count,size=result?.package_bytes;
  if(status!==(verify?'PROJECT_REVISION_REVIEW_PACKAGE_VERIFIED':'PROJECT_REVISION_REVIEW_PACKAGE_CREATED')||
     typeof manifest!=='string'||!SHA256.test(manifest)||(expected!==undefined&&manifest!==expected)||commits.some(v=>typeof v!=='string'||!SHA1.test(v))||
     [baseCount,originalCount].some(v=>!Number.isSafeInteger(v)||v<1||v>50)||!Number.isSafeInteger(size)||size<1||size>29*1024*1024||
     !verify&&(commits[0]!==spec.original_result?.base_commit||commits[0]!==spec.revised_result?.base_commit||
       commits[1]!==spec.original_result?.candidate_commit||commits[2]!==spec.revised_result?.candidate_commit||
       baseCount!==spec.revised_result?.changed_paths?.length||originalCount!==spec.revised_result?.revised_blobs?.length))throw null;
  return `${status}\nManifest SHA256: ${manifest}\nBase commit: ${commits[0]}\nOriginal commit: ${commits[1]}\nRevised commit: ${commits[2]}\nBase-to-revised path count: ${baseCount}\nOriginal-to-revised path count: ${originalCount}\nPackage bytes: ${size}\nCOPY_INTEGRITY_ONLY; NO_DECISION_OR_EXECUTION_AUTHORITY\n`;
}

function snapshotLines(result,spec,expectedReceipt){
  const verification=expectedReceipt!==undefined;
  const status=result?.status,source=result?.source_snapshot_manifest_sha256,manifest=result?.manifest_sha256,
    provenance=result?.provenance_sha256,input=result?.input_result_sha256,objects=OBJECTS.map(k=>result?.[k]),
    count=result?.changed_path_count,size=result?.package_bytes;
  if(status!==(verification?'PROJECT_CANDIDATE_REVIEW_SNAPSHOT_HANDOFF_VERIFIED':'PROJECT_CANDIDATE_REVIEW_PACKAGE_CREATED_FROM_SNAPSHOT')||
     [source,manifest,provenance,input].some(v=>typeof v!=='string'||v.length!==64||!SHA256.test(v))||
     (verification?provenance!==expectedReceipt:source!==spec.expected_manifest_sha256)||objects.some(v=>typeof v!=='string'||!SHA1.test(v))||
     !Number.isSafeInteger(count)||count<1||count>50||!Number.isSafeInteger(size)||size<1||size>17*1024*1024)throw null;
  return `${status}\nSource snapshot SHA256: ${source}\nManifest SHA256: ${manifest}\nProvenance SHA256: ${provenance}\nInput result SHA256: ${input}\nBase commit: ${objects[0]}\nBase tree: ${objects[1]}\nCandidate commit: ${objects[2]}\nCandidate tree: ${objects[3]}\nChanged path count: ${count}\nPackage bytes: ${size}\nPackage relative directory: package\n${verification?'SELECTED_HANDOFF_INTEGRITY_ONLY; NO_AUTHENTICITY_OR_ACKNOWLEDGEMENT_RECOVERY':'RETAINED_SNAPSHOT_SOURCE_ONLY; NO_LIVE_CUSTODY_OR_ORIGINAL_RESULT_VALIDATION'}\n`;
}

function retainedLines(result,{verification,fromRetained,spec,expected}){
  const status=result?.status,manifest=result?.manifest_sha256,source=result?.source_manifest_sha256,provenance=result?.provenance_sha256;
  const keys=['base_commit','base_tree','original_commit','original_tree','revised_commit','revised_tree'],ids=keys.map(k=>result?.[k]);
  const a=result?.base_to_revised_count,b=result?.original_to_revised_count,u=result?.union_count,objectCount=result?.object_count,retainedBytes=result?.retained_bytes,packageBytes=result?.package_bytes;
  if(status!==(fromRetained?'PROJECT_REVISION_REVIEW_PACKAGE_CREATED_FROM_RETAINED_SOURCE':verification?'PROJECT_RETAINED_REVISION_SOURCE_VERIFIED':'PROJECT_RETAINED_REVISION_SOURCE_CREATED')||
     typeof manifest!=='string'||manifest.length!==64||!SHA256.test(manifest)||ids.some(v=>typeof v!=='string'||v.length!==40||!SHA1.test(v))||[a,b,u].some(n=>!Number.isSafeInteger(n)||n<1||n>50)||u<Math.max(a,b)||u>a+b||
     (verification&&manifest!==expected))throw null;
  let extra;if(fromRetained){if(typeof source!=='string'||source!==spec.expected_manifest_sha256||typeof provenance!=='string'||provenance.length!==64||!SHA256.test(provenance)||!Number.isSafeInteger(packageBytes)||packageBytes<1||packageBytes>29*1024*1024)throw null;
    extra=`Source manifest SHA256: ${source}\nProvenance SHA256: ${provenance}\nPackage bytes: ${packageBytes}\nPackage relative directory: package\n`;
  }else{if(!Number.isSafeInteger(objectCount)||objectCount<3||objectCount>8192||!Number.isSafeInteger(retainedBytes)||retainedBytes<1||retainedBytes>64*1024*1024)throw null;
    if(!verification&&(ids[0]!==spec.original_result?.base_commit||ids[1]!==spec.original_result?.base_tree||ids[2]!==spec.original_result?.candidate_commit||ids[3]!==spec.original_result?.candidate_tree||ids[4]!==spec.revised_result?.candidate_commit||ids[5]!==spec.revised_result?.candidate_tree||a!==spec.revised_result?.changed_paths?.length||b!==spec.revised_result?.revised_blobs?.length))throw null;
    extra=`Object count: ${objectCount}\nRetained bytes: ${retainedBytes}\n`;
  }
  return `${status}\nManifest SHA256: ${manifest}\n${keys.map((k,i)=>k+': '+ids[i]).join('\n')}\nBase-to-revised path count: ${a}\nOriginal-to-revised path count: ${b}\nUnion path count: ${u}\n${extra}COPY_INTEGRITY_ONLY; NO_AUTHENTICITY_OR_ORIGINAL_ACKNOWLEDGEMENT_RECOVERY\n`;
}

/** Trusted injected operations are for deterministic callers/tests; the executable uses fixed APIs. */
export async function runCandidateReviewCli(argv,ports={}){
  let bytes;
  try{
    closed(ports,[],['readBytes','build','verify','buildRevision','verifyRevision','buildFromSnapshot','verifySnapshotHandoff','retainRevisionSource','verifyRetainedRevisionSource','buildRevisionFromRetained','stdout','stderr'],'candidate_review_cli_ports');
    let outputFailed=false;
    const output=key=>{
      const stream=ports[key]??process[key],method=stream.write;
      if(typeof method!=='function'||types.isProxy(method))throw null;
      return text=>{if(outputFailed)return;try{return Reflect.apply(method,stream,[text]);}catch{outputFailed=true;}};
    };
    const stdout=output('stdout'),stderr=output('stderr');
    if(Array.isArray(argv)&&argv.length===1&&argv[0]==='--help'){stdout(USAGE+RETAINED_USAGE);return outputFailed?2:0;}
    if(Array.isArray(argv)&&['--retain-revision-source','--verify-retained-revision-source','--build-revision-from-retained'].includes(argv[0])){
      const mode=argv[0],verification=mode==='--verify-retained-revision-source',fromRetained=mode==='--build-revision-from-retained';
      if(argv.length!==(verification?3:2)||!absolute(argv[1])||(verification&&(typeof argv[2]!=='string'||argv[2].length!==64||!SHA256.test(argv[2])))){stderr(USAGE+RETAINED_USAGE);return 2;}
      try{
        let spec;const expected=verification?argv[2]:undefined;
        const op=verification?(ports.verifyRetainedRevisionSource??verifyProjectRetainedRevisionReviewSource):fromRetained?(ports.buildRevisionFromRetained??buildProjectRevisionReviewPackageFromRetainedSource):(ports.retainRevisionSource??buildProjectRetainedRevisionReviewSource);
        if(typeof op!=='function'||types.isProxy(op))throw null;
        if(!verification){const read=ports.readBytes??readReceiptBytes;if(typeof read!=='function'||types.isProxy(read))throw null;
          const max=fromRetained?MAX_SPEC_BYTES:MAX_REVISION_SPEC_BYTES,raw=await Reflect.apply(read,ports,[argv[1],max]);
          if(!types.isUint8Array(raw)||types.isProxy(raw))throw null;const length=Reflect.apply(byteLength,raw,[]);if(length>max)throw null;
          bytes=new Uint8Array(length);Uint8Array.prototype.set.call(bytes,raw);spec=parseReceiptJson(bytes);
          if(fromRetained){closed(spec,['schema','retained_source_dir','expected_manifest_sha256','output_dir'],[],'retained_revision_cli');
            if(spec.schema!=='SQUIRE_PROJECT_REVISION_REVIEW_RETAINED_SPEC_V1'||!absolute(spec.retained_source_dir)||!absolute(spec.output_dir)||typeof spec.expected_manifest_sha256!=='string'||spec.expected_manifest_sha256.length!==64||!SHA256.test(spec.expected_manifest_sha256)||spec.output_dir===spec.retained_source_dir||spec.output_dir.startsWith(spec.retained_source_dir+'/')||spec.retained_source_dir.startsWith(spec.output_dir+'/'))throw null;
          }else{closed(spec,['schema','original_result','revised_result','base_git_dir','base_git_identity','original_git_dir','original_git_identity','revised_git_dir','revised_git_identity','output_dir','original_package','prior_decisions','selected_decision_id'],[],'retained_revision_cli');
            if(spec.schema!=='SQUIRE_PROJECT_RETAINED_REVISION_SOURCE_SPEC_V1'||!Array.isArray(spec.prior_decisions)||spec.prior_decisions.length<1||spec.prior_decisions.length>8||![spec.base_git_dir,spec.original_git_dir,spec.revised_git_dir,spec.output_dir,spec.original_package?.dir,...spec.prior_decisions.map(x=>x?.dir)].every(absolute))throw null;}}
        const result=await Reflect.apply(op,ports,verification?[argv[1],expected]:[spec]);
        stdout(retainedLines(result,{verification,fromRetained,spec,expected}));return outputFailed?2:0;
      }catch{stderr('PROJECT_RETAINED_REVISION_SOURCE_REJECTED\n');return 2;}
    }
    if(Array.isArray(argv)&&argv.length===3&&argv[0]==='--verify-snapshot-handoff'){
      const root=argv[1],expected=argv[2];
      if(!absolute(root)||typeof expected!=='string'||expected.length!==64||!SHA256.test(expected)){stderr(USAGE);return 2;}
      try{
        const operation=ports.verifySnapshotHandoff??verifyProjectCandidateReviewSnapshotHandoff;
        if(typeof operation!=='function'||types.isProxy(operation))throw null;
        const result=await Reflect.apply(operation,ports,[root,expected]);
        stdout(snapshotLines(result,undefined,expected));return outputFailed?2:0;
      }catch{stderr(REJECTED);return 2;}
    }
    const mode=Array.isArray(argv)&&(argv.length===2||argv.length===4)?argv[0]:null;
    const path=['--build','--verify','--build-revision','--verify-revision','--build-from-snapshot'].includes(mode)?argv[1]:null;
    const expected=Array.isArray(argv)&&argv.length===4?argv[3]:undefined;
    if(!absolute(path)||(argv.length===4&&(!['--verify','--verify-revision'].includes(mode)||
       argv[2]!=='--expect-sha256'||typeof expected!=='string'||!SHA256.test(expected)))){stderr(USAGE);return 2;}
    const revision=mode==='--build-revision'||mode==='--verify-revision',snapshot=mode==='--build-from-snapshot';
    try{
      const verify=mode==='--verify'||mode==='--verify-revision';
      const operation=snapshot?(ports.buildFromSnapshot??buildProjectCandidateReviewPackageFromSnapshot):revision?(verify?(ports.verifyRevision??verifyProjectRevisionReviewPackage):(ports.buildRevision??buildProjectRevisionReviewPackage)):
        (verify?(ports.verify??verifyProjectCandidateReviewPackage):(ports.build??buildProjectCandidateReviewPackage));
      if(typeof operation!=='function'||types.isProxy(operation))throw null;
      let spec;
      if(!verify){
        const read=ports.readBytes??readReceiptBytes;
        if(typeof read!=='function'||types.isProxy(read))throw null;
        const maxBytes=revision?MAX_REVISION_SPEC_BYTES:MAX_SPEC_BYTES;
        const raw=await Reflect.apply(read,ports,[path,maxBytes]);
        if(!types.isUint8Array(raw)||types.isProxy(raw))throw null;
        const length=Reflect.apply(byteLength,raw,[]);if(length>maxBytes)throw null;
        bytes=new Uint8Array(length);Uint8Array.prototype.set.call(bytes,raw);
        spec=parseReceiptJson(bytes);
        if(snapshot){
          closed(spec,['schema','snapshot_dir','expected_manifest_sha256','output_dir'],[],'snapshot_review_cli_spec');
          if(spec.schema!=='SQUIRE_PROJECT_CANDIDATE_REVIEW_FROM_SNAPSHOT_SPEC_V1'||!absolute(spec.snapshot_dir)||!absolute(spec.output_dir)||
             typeof spec.expected_manifest_sha256!=='string'||spec.expected_manifest_sha256.length!==64||!SHA256.test(spec.expected_manifest_sha256)||
             spec.snapshot_dir===spec.output_dir||spec.snapshot_dir.startsWith(spec.output_dir+'/')||spec.output_dir.startsWith(spec.snapshot_dir+'/'))throw null;
        }else if(revision){
          closed(spec,['schema','original_result','revised_result','base_git_dir','base_git_identity','original_git_dir',
            'original_git_identity','revised_git_dir','revised_git_identity','output_dir','original_package','prior_decisions','selected_decision_id'],[],'revision_review_cli_spec');
          if(spec.schema!=='SQUIRE_PROJECT_REVISION_REVIEW_SPEC_V1'||!Array.isArray(spec.prior_decisions)||spec.prior_decisions.length<1||spec.prior_decisions.length>8||
             ![spec.base_git_dir,spec.original_git_dir,spec.revised_git_dir,spec.output_dir,spec.original_package?.dir,...spec.prior_decisions.map(v=>v?.dir)].every(absolute))throw null;
        }else{
          closed(spec,['schema','result','candidate_git_dir','candidate_git_identity','base_git_dir','base_git_identity','output_dir'],[],'candidate_review_cli_spec');
          if(spec.schema!=='SQUIRE_PROJECT_CANDIDATE_REVIEW_SPEC_V1'||!['candidate_git_dir','base_git_dir','output_dir'].every(k=>absolute(spec[k])))throw null;
        }
      }
      const builtInExpectedVerifier=expected!==undefined&&
        ((mode==='--verify'&&operation===verifyProjectCandidateReviewPackage)||
         (mode==='--verify-revision'&&operation===verifyProjectRevisionReviewPackage));
      const args=builtInExpectedVerifier
        ?[path,undefined,expected]:[verify?path:spec];
      const result=await Reflect.apply(operation,ports,args);
      if(snapshot){stdout(snapshotLines(result,spec));return outputFailed?2:0;}
      if(revision){stdout(revisionLines(result,spec,verify,expected));return outputFailed?2:0;}
      const status=result?.status,manifest=result?.manifest_sha256,objects=OBJECTS.map(k=>result?.[k]),count=result?.changed_path_count,size=result?.package_bytes;
      if(status!==(verify?'PROJECT_CANDIDATE_REVIEW_PACKAGE_VERIFIED':'PROJECT_CANDIDATE_REVIEW_PACKAGE_CREATED')||
         typeof manifest!=='string'||!SHA256.test(manifest)||(expected!==undefined&&manifest!==expected)||objects.some(v=>typeof v!=='string'||!SHA1.test(v))||
         !Number.isSafeInteger(count)||count<1||count>50||!Number.isSafeInteger(size)||size<1||size>17*1024*1024||
         !verify&&(OBJECTS.some((k,i)=>objects[i]!==spec.result?.[k])||count!==spec.result?.changed_paths?.length))throw null;
      stdout(`${status}\nManifest SHA256: ${manifest}\nBase commit: ${objects[0]}\nBase tree: ${objects[1]}\nCandidate commit: ${objects[2]}\nCandidate tree: ${objects[3]}\nChanged path count: ${count}\nPackage bytes: ${size}\nCOPY_INTEGRITY_ONLY; NO_DECISION_OR_EXECUTION_AUTHORITY\n`);
      return outputFailed?2:0;
    }catch{stderr(revision?'PROJECT_REVISION_REVIEW_REJECTED\n':REJECTED);return 2;}
  }catch{return 2;}
  finally{bytes?.fill(0);}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  let outputFailed=false;
  const outputError=()=>{outputFailed=true;process.exitCode=2;};
  process.stdout.on('error',outputError);process.stderr.on('error',outputError);
  const code=await runCandidateReviewCli(process.argv.slice(2));
  process.exitCode=outputFailed?2:code;
}
