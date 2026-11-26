// Explicit source-decision recording and selected revision verification. Import is inert.
import {decisionFeedback} from '../src/internal/decision-request-feedback.mjs';
import {pathToFileURL} from 'node:url';
import {resolve,parse} from 'node:path';
import {types} from 'node:util';
import {closed} from '../src/job-spec.mjs';
import {parseReceiptJson,parseRevisionDecisionJson} from '../src/offline-run-summary.mjs';
import {readReceiptBytes} from './squire-report.mjs';
import {recordProjectCandidateDecision,verifyProjectCandidateDecision} from '../src/project-candidate-review-package.mjs';
import {recordProjectRevisionDecision,verifyProjectRevisionDecision} from '../src/project-revision-review-package.mjs';
import {MAX_REVIEW_DECISION_BYTES} from '../src/project-review-decision-limits.mjs';

const USAGE='Usage: node bin/squire-candidate-decision.mjs record <package-dir> <decision-request.json> <fresh-decision-dir>\n       node bin/squire-candidate-decision.mjs record-revision <revision-package-dir> <decision-request.json> <fresh-decision-dir>\n       node bin/squire-candidate-decision.mjs verify-revision-decision <revision-package-dir> <decision-dir> <expected-decision-sha256>\n       node bin/squire-candidate-decision.mjs verify-decision <package-dir> <decision-dir> <expected-decision-sha256>\n';
const SHA256=/^[a-f0-9]{64}$/;
const byteLength=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype),'byteLength').get;
const absolute=value=>typeof value==='string'&&value.length>1&&value.length<=4096&&value.startsWith('/')&&
  resolve(value)===value&&value!==parse(value).root&&!/[\\\u0000-\u001f\u007f]/u.test(value);

/** Trusted injected I/O is for deterministic callers/tests; the executable uses fixed defaults. */
export async function runCandidateDecisionCli(argv,ports={}){
  let bytes;
  try{
    closed(ports,[],['readBytes','record','recordRevision','verifyRevisionDecision','verifyDecision','stdout','stderr'],'candidate_decision_cli_ports');
    let outputFailed=false;
    const output=key=>{
      const stream=ports[key]??process[key],method=stream.write;
      if(typeof method!=='function'||types.isProxy(method))throw null;
      return text=>{if(outputFailed)return;try{return Reflect.apply(method,stream,[text]);}catch{outputFailed=true;}};
    };
    const stdout=output('stdout'),stderr=output('stderr');
    if(Array.isArray(argv)&&argv.length===1&&argv[0]==='--help'){
      stdout(USAGE+'Append --explain to record or record-revision for a fixed rejection category.\n');return outputFailed?2:0;
    }
    if(Array.isArray(argv)&&argv.length===4&&argv[0]==='verify-decision'){
      const [packageDir,decisionDir,expected]=[argv[1],argv[2],argv[3]];
      if(!absolute(packageDir)||!absolute(decisionDir)||typeof expected!=='string'||!SHA256.test(expected)){stderr(USAGE);return 2;}
      try{
        const verify=ports.verifyDecision??verifyProjectCandidateDecision;
        if(typeof verify!=='function'||types.isProxy(verify))throw null;
        const result=await Reflect.apply(verify,ports,[packageDir,decisionDir,expected]);
        const status=result?.status,packageDigest=result?.review_package_sha256,decisionDigest=result?.decision_sha256,count=result?.attested_path_count;
        if(status!=='PROJECT_CANDIDATE_DECISION_VERIFIED'||typeof packageDigest!=='string'||!SHA256.test(packageDigest)||
           typeof decisionDigest!=='string'||!SHA256.test(decisionDigest)||decisionDigest!==expected||
           !Number.isSafeInteger(count)||count<0||count>50)throw null;
        stdout(`PROJECT_CANDIDATE_DECISION_VERIFIED\nPackage SHA256: ${packageDigest}\nDecision SHA256: ${decisionDigest}\nAttested path count: ${count}\nSELECTED_RECORD_INTEGRITY_ONLY; NO_EXECUTION_OR_MERGE_AUTHORITY\n`);
        return outputFailed?2:0;
      }catch{stderr('PROJECT_CANDIDATE_DECISION_REJECTED\n');return 2;}
    }
    if(Array.isArray(argv)&&argv.length===4&&argv[0]==='verify-revision-decision'){
      const [packageDir,decisionDir,expected]=[argv[1],argv[2],argv[3]];
      if(!absolute(packageDir)||!absolute(decisionDir)||typeof expected!=='string'||!SHA256.test(expected)){stderr(USAGE);return 2;}
      try{
        const verify=ports.verifyRevisionDecision??verifyProjectRevisionDecision;
        if(typeof verify!=='function'||types.isProxy(verify))throw null;
        const result=await Reflect.apply(verify,ports,[packageDir,decisionDir,expected]);
        const status=result?.status,packageDigest=result?.revision_package_sha256,decisionDigest=result?.decision_sha256,
          choice=result?.choice,count=result?.attested_path_count;
        if(status!=='PROJECT_REVISION_DECISION_VERIFIED'||typeof packageDigest!=='string'||!SHA256.test(packageDigest)||
           typeof decisionDigest!=='string'||!SHA256.test(decisionDigest)||decisionDigest!==expected||
           !['ACCEPT','REVISE','REJECT'].includes(choice)||!Number.isSafeInteger(count)||count<0||count>100)throw null;
        stdout(`PROJECT_REVISION_DECISION_VERIFIED\nRevision package SHA256: ${packageDigest}\nDecision SHA256: ${decisionDigest}\nAttested path count: ${count}\nSELECTED_RECORD_INTEGRITY_ONLY; NO_EXECUTION_OR_MERGE_AUTHORITY\n`);
        return outputFailed?2:0;
      }catch{stderr('PROJECT_REVISION_DECISION_REJECTED\n');return 2;}
    }
    const explain=Array.isArray(argv)&&argv.length===5&&argv[4]==='--explain';
    const paths=Array.isArray(argv)&&(argv.length===4||explain)&&['record','record-revision'].includes(argv[0])?[argv[1],argv[2],argv[3]]:null;
    if(!paths||!paths.every(absolute)){
      stderr(USAGE);return 2;
    }
    const [packageDir,requestPath,decisionDir]=paths;
    const revision=argv[0]==='record-revision';
    const statusExpected=revision?'PROJECT_REVISION_DECISION_RECORDED':'PROJECT_CANDIDATE_DECISION_RECORDED';
    const digestKey=revision?'revision_package_sha256':'review_package_sha256';
    const rejected=revision?'PROJECT_REVISION_DECISION_REJECTED\n':'PROJECT_CANDIDATE_DECISION_REJECTED\n';
    let category='REQUEST_UNREADABLE';
    try{
      const read=ports.readBytes??readReceiptBytes,record=revision?(ports.recordRevision??recordProjectRevisionDecision):(ports.record??recordProjectCandidateDecision);
      if(typeof read!=='function'||types.isProxy(read)||typeof record!=='function'||types.isProxy(record))throw null;
      const raw=await Reflect.apply(read,ports,[requestPath,MAX_REVIEW_DECISION_BYTES]);
      if(!types.isUint8Array(raw)||types.isProxy(raw))throw null;
      category='MALFORMED_REQUEST';
      const length=Reflect.apply(byteLength,raw,[]);if(length>MAX_REVIEW_DECISION_BYTES)throw null;
      bytes=new Uint8Array(length);Uint8Array.prototype.set.call(bytes,raw);
      const request=revision?parseRevisionDecisionJson(bytes):parseReceiptJson(bytes);
      category='RECORDING_OUTCOME_UNCERTAIN';
      const result=await Reflect.apply(record,ports,[packageDir,request,decisionDir]);
      const status=result?.status,packageDigest=result?.[digestKey],decisionDigest=result?.decision_sha256;
      if(status!==statusExpected||typeof packageDigest!=='string'||!SHA256.test(packageDigest)||
         typeof decisionDigest!=='string'||!SHA256.test(decisionDigest)||packageDigest!==request?.[digestKey]||
         result.choice!==request?.choice)throw null;
      stdout(`${statusExpected}\n${revision?'Revision package':'Package'} SHA256: ${packageDigest}\nDecision SHA256: ${decisionDigest}\nSOURCE_DECISION_ONLY; NO_EXECUTION_OR_MERGE_AUTHORITY\n`);
      return outputFailed?2:0;
    }catch(error){
      if(explain&&category==='RECORDING_OUTCOME_UNCERTAIN')category=decisionFeedback(error)??category;
      if(category==='REQUEST_UNREADABLE'&&error==='FILE_TOO_LARGE')category='MALFORMED_REQUEST';
      stderr(explain?rejected+`Reason: ${category}\n`:rejected);
      return 2;
    }
  }catch{return 2;}
  finally{bytes?.fill(0);}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  let outputFailed=false;
  const outputError=()=>{outputFailed=true;process.exitCode=2;};
  process.stdout.on('error',outputError);process.stderr.on('error',outputError);
  const code=await runCandidateDecisionCli(process.argv.slice(2));
  process.exitCode=outputFailed?2:code;
}
