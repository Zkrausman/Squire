// Explicit local build/verify only; no task execution or automatic source publication.
import * as fs from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {buildReviewPackage,verifyReviewPackage,safePackageErrorCode,ReviewPackageError,checkReviewPackageAbort} from '../src/human-review-package.mjs';

// The CLI's native inventory has a fixed four-name contract. Injected fs ports
// retain their existing readdir semantics; this bounds only the default adapter.
export async function nativePackageInventory(native,path,signal){
  const abort=()=>checkReviewPackageAbort(signal);
  abort();
  let dir;
  try{
    dir=await native.opendir(path,{bufferSize:1});
    abort();
    const entries=[];
    for(let i=0;i<5;i++){
      const entry=await dir.read();
      abort();
      if(entry===null)return entries;
      if(!entry||typeof entry.name!=='string')throw new ReviewPackageError('PACKAGE_IO_ERROR');
      entries.push(entry.name);
      if(entries.length===5)throw new ReviewPackageError('PACKAGE_IO_ERROR');
    }
    throw new ReviewPackageError('PACKAGE_IO_ERROR');
  }finally{await dir?.close();}
}
export async function runPackageCli(args,ports={}){
  try{
    let outputFailed=false;
    const output=key=>{
      const stream=ports[key]??process[key],method=stream.write;
      if(typeof method!=='function')throw null;
      return {write(...args){
        if(outputFailed)return;
        try{return Reflect.apply(method,stream,args);}catch{outputFailed=true;}
      }};
    };
    const stdout=output('stdout'),stderr=output('stderr');
    const code=await runPackageCliInternal(args,ports,stdout,stderr);
    return outputFailed?2:code;
  }catch{return 2;}
}
const USAGE='Usage: node bin/squire-package.mjs --build <receipt> <source> <output-dir> | --verify <output-dir> [expected-manifest-sha256]\n';
async function runPackageCliInternal(args,ports,stdout,stderr){
  if(Array.isArray(args)&&args.length===1&&args[0]==='--help'){
    stdout.write(USAGE);return 0;
  }
  const build=Array.isArray(args)&&args[0]==='--build'&&args.length===4;
  const verify=Array.isArray(args)&&args[0]==='--verify'&&
    (args.length===2||(args.length===3&&typeof args[2]==='string'));
  if(!build&&!verify){stderr.write(USAGE);return 2;}
  try{
    const io={fs:ports.fs??{...fs,readdir:path=>nativePackageInventory(fs,path,ports.signal)},uid:ports.uid??(typeof process.getuid==='function'?process.getuid():null),signal:ports.signal};
    const result=build?await buildReviewPackage({receipt_path:args[1],source_path:args[2],output_dir:args[3]},io):await verifyReviewPackage(args[1],io,args[2]);
    if(result.status==='CORRUPT_OR_INCOMPLETE'){stderr.write('CORRUPT_OR_INCOMPLETE\n');return 2;}
    if(result.status==='VERIFICATION_ABORTED'){stderr.write('PACKAGE_ABORTED\n');return 2;}
    stdout.write('Squire local review package: '+(result.status==='VERIFIED'?'VERIFIED':'COMPLETE')+'\nSchema: squire3.package_manifest.v1\nManifest SHA256: '+result.manifest_sha256+'\nFiles: artifact.mjs, summary.json, README.txt, package-manifest.json\nOutcome: '+result.readiness_or_outcome+'\nTask correctness: '+result.task_correctness+'\nOriginal acknowledgement/provenance/crash durability are not proven by verification.\n');return result.exit_code;
  }catch(e){stderr.write(safePackageErrorCode(e)+'\n');return 2;}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  // Executable lifetime only: observe errors without retrying output or artifacts.
  let outputFailed=false;
  const outputError=()=>{outputFailed=true;process.exitCode=2;};
  process.stdout.on('error',outputError);process.stderr.on('error',outputError);
  const code=await runPackageCli(process.argv.slice(2));
  process.exitCode=outputFailed?2:code;
}
