// Explicit offline original/first-revision package build/verification only; import is inert.
import {pathToFileURL} from 'node:url';
import {resolve,parse} from 'node:path';
import {types} from 'node:util';
import {closed} from '../src/job-spec.mjs';
import {parseReceiptJson} from '../src/offline-run-summary.mjs';
import {readReceiptBytes} from './squire-report.mjs';
import {buildProjectCandidateReviewPackage,verifyProjectCandidateReviewPackage} from '../src/project-candidate-review-package.mjs';
import {buildProjectRevisionReviewPackage,verifyProjectRevisionReviewPackage} from '../src/project-revision-review-package.mjs';

const USAGE='Usage: node bin/squire-candidate-review.mjs <--build|--verify> <spec.json|package-dir>\n       node bin/squire-candidate-review.mjs <--build-revision|--verify-revision> <spec.json|package-dir>\n';
const REJECTED='PROJECT_CANDIDATE_REVIEW_REJECTED\n';
const MAX_SPEC_BYTES=65536,MAX_REVISION_SPEC_BYTES=262144;
const SHA256=/^[a-f0-9]{64}$/,SHA1=/^[a-f0-9]{40}$/;
const OBJECTS=['base_commit','base_tree','candidate_commit','candidate_tree'];
const byteLength=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype),'byteLength').get;
const absolute=v=>typeof v==='string'&&v.length>1&&v.length<=4096&&v.startsWith('/')&&resolve(v)===v&&v!==parse(v).root&&!/[\\\u0000-\u001f\u007f]/u.test(v);

function revisionLines(result,spec,verify){
  const status=result?.status,manifest=result?.manifest_sha256;
  const commits=[result?.base_commit,result?.original_commit,result?.revised_commit];
  const baseCount=result?.base_to_revised_count,originalCount=result?.original_to_revised_count,size=result?.package_bytes;
  if(status!==(verify?'PROJECT_REVISION_REVIEW_PACKAGE_VERIFIED':'PROJECT_REVISION_REVIEW_PACKAGE_CREATED')||
     typeof manifest!=='string'||!SHA256.test(manifest)||commits.some(v=>typeof v!=='string'||!SHA1.test(v))||
     [baseCount,originalCount].some(v=>!Number.isSafeInteger(v)||v<1||v>50)||!Number.isSafeInteger(size)||size<1||size>29*1024*1024||
     !verify&&(commits[0]!==spec.original_result?.base_commit||commits[0]!==spec.revised_result?.base_commit||
       commits[1]!==spec.original_result?.candidate_commit||commits[2]!==spec.revised_result?.candidate_commit||
       baseCount!==spec.revised_result?.changed_paths?.length||originalCount!==spec.revised_result?.revised_blobs?.length))throw null;
  return `${status}\nManifest SHA256: ${manifest}\nBase commit: ${commits[0]}\nOriginal commit: ${commits[1]}\nRevised commit: ${commits[2]}\nBase-to-revised path count: ${baseCount}\nOriginal-to-revised path count: ${originalCount}\nPackage bytes: ${size}\nCOPY_INTEGRITY_ONLY; NO_DECISION_OR_EXECUTION_AUTHORITY\n`;
}

/** Trusted injected operations are for deterministic callers/tests; the executable uses fixed APIs. */
export async function runCandidateReviewCli(argv,ports={}){
  let bytes;
  try{
    closed(ports,[],['readBytes','build','verify','buildRevision','verifyRevision','stdout','stderr'],'candidate_review_cli_ports');
    let outputFailed=false;
    const output=key=>{
      const stream=ports[key]??process[key],method=stream.write;
      if(typeof method!=='function'||types.isProxy(method))throw null;
      return text=>{if(outputFailed)return;try{return Reflect.apply(method,stream,[text]);}catch{outputFailed=true;}};
    };
    const stdout=output('stdout'),stderr=output('stderr');
    if(Array.isArray(argv)&&argv.length===1&&argv[0]==='--help'){stdout(USAGE);return outputFailed?2:0;}
    const mode=Array.isArray(argv)&&argv.length===2?argv[0]:null;
    const path=['--build','--verify','--build-revision','--verify-revision'].includes(mode)?argv[1]:null;
    if(!absolute(path)){stderr(USAGE);return 2;}
    const revision=mode==='--build-revision'||mode==='--verify-revision';
    try{
      const verify=mode==='--verify'||mode==='--verify-revision';
      const operation=revision?(verify?(ports.verifyRevision??verifyProjectRevisionReviewPackage):(ports.buildRevision??buildProjectRevisionReviewPackage)):
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
        if(revision){
          closed(spec,['schema','original_result','revised_result','base_git_dir','base_git_identity','original_git_dir',
            'original_git_identity','revised_git_dir','revised_git_identity','output_dir','original_package','prior_decisions','selected_decision_id'],[],'revision_review_cli_spec');
          if(spec.schema!=='SQUIRE_PROJECT_REVISION_REVIEW_SPEC_V1'||!Array.isArray(spec.prior_decisions)||spec.prior_decisions.length<1||spec.prior_decisions.length>8||
             ![spec.base_git_dir,spec.original_git_dir,spec.revised_git_dir,spec.output_dir,spec.original_package?.dir,...spec.prior_decisions.map(v=>v?.dir)].every(absolute))throw null;
        }else{
          closed(spec,['schema','result','candidate_git_dir','candidate_git_identity','base_git_dir','base_git_identity','output_dir'],[],'candidate_review_cli_spec');
          if(spec.schema!=='SQUIRE_PROJECT_CANDIDATE_REVIEW_SPEC_V1'||!['candidate_git_dir','base_git_dir','output_dir'].every(k=>absolute(spec[k])))throw null;
        }
      }
      const result=await Reflect.apply(operation,ports,[verify?path:spec]);
      if(revision){stdout(revisionLines(result,spec,verify));return outputFailed?2:0;}
      const status=result?.status,manifest=result?.manifest_sha256,objects=OBJECTS.map(k=>result?.[k]),count=result?.changed_path_count,size=result?.package_bytes;
      if(status!==(verify?'PROJECT_CANDIDATE_REVIEW_PACKAGE_VERIFIED':'PROJECT_CANDIDATE_REVIEW_PACKAGE_CREATED')||
         typeof manifest!=='string'||!SHA256.test(manifest)||objects.some(v=>typeof v!=='string'||!SHA1.test(v))||
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
