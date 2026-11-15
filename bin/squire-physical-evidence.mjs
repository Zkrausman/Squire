// Explicit, offline copy-integrity inspection of one selected private attempt.
import {dirname,parse,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {verifyProjectPhysicalJobEvidence} from '../src/project-physical-job-evidence.mjs';

const USAGE='Usage: node bin/squire-physical-evidence.mjs verify <absolute-attempt-dir> <expected-manifest-sha256> [--json]\n';
const HEX=/^[a-f0-9]{64}$/;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const CODES=new Set(['INVALID_EVIDENCE_SPEC','EVIDENCE_CUSTODY_REJECTED','EVIDENCE_CAPACITY_REJECTED','EVIDENCE_INTEGRITY_REJECTED','EVIDENCE_IO_UNKNOWN']);
const SUCCESS=Object.freeze({schema:'SQUIRE_PHYSICAL_EVIDENCE_CLI_V1',status:'COPY_INTEGRITY_VERIFIED',copy_integrity:'VERIFIED',acknowledgement:'UNKNOWN'});

function selectedAttempt(path){
  return typeof path==='string'&&path.length>1&&path.length<=4096&&path.startsWith('/')&&
    resolve(path)===path&&path!==parse(path).root&&!/[\\\u0000-\u001f\u007f]/u.test(path)&&
    parse(dirname(path)).base==='attempts'&&UUID.test(parse(path).base);
}
function rejectionCode(error){
  try{const code=error?.code;return typeof code==='string'&&CODES.has(code)?code:'EVIDENCE_IO_UNKNOWN';}
  catch{return 'EVIDENCE_IO_UNKNOWN';}
}
export async function runPhysicalEvidenceCli(argv,ports={}){
  try{
    let outputFailed=false;
    const output=key=>{
      const stream=ports[key]??process[key],method=stream.write;
      if(typeof method!=='function')throw null;
      return value=>{if(outputFailed)return false;
        try{Reflect.apply(method,stream,[value]);return true;}catch{outputFailed=true;return false;}};
    };
    const stdout=output('stdout'),stderr=output('stderr');
    if(Array.isArray(argv)&&argv.length===1&&argv[0]==='--help')return stdout(USAGE)?0:1;
    if(!Array.isArray(argv)||![3,4].includes(argv.length)||argv[0]!=='verify'||
       !selectedAttempt(argv[1])||!HEX.test(argv[2])||argv.length===4&&argv[3]!=='--json'){
      stderr(USAGE);return 2;
    }
    try{
      const verify=ports.verify??verifyProjectPhysicalJobEvidence;
      const result=await verify(argv[1],argv[2]);
      if(result?.status!=='PHYSICAL_EVIDENCE_COPY_VERIFIED'||result.copy_integrity!=='VERIFIED'||result.acknowledgement!=='UNKNOWN')throw null;
      const text=argv.length===4?JSON.stringify(SUCCESS)+'\n':'COPY_INTEGRITY_VERIFIED ACKNOWLEDGEMENT_UNKNOWN\n';
      return stdout(text)?0:1;
    }catch(error){stderr(rejectionCode(error)+'\n');return 1;}
  }catch{return 1;}
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  let outputFailed=false;
  const outputError=()=>{outputFailed=true;process.exitCode=1;};
  process.stdout.on('error',outputError);process.stderr.on('error',outputError);
  const code=await runPhysicalEvidenceCli(process.argv.slice(2));
  process.exitCode=outputFailed?1:code;
}
