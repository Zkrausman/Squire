// Explicit local build/verify only; no task execution or automatic source publication.
import * as fs from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {buildReviewPackage,verifyReviewPackage,safePackageErrorCode} from '../src/human-review-package.mjs';
export async function runPackageCli(args,ports={}){
  const stdout=ports.stdout??process.stdout,stderr=ports.stderr??process.stderr;
  if(!Array.isArray(args)||!((args[0]==='--build'&&args.length===4)||(args[0]==='--verify'&&args.length===2))){stderr.write('Usage: node bin/squire-package.mjs --build <receipt> <source> <output-dir> | --verify <output-dir>\n');return 2;}
  try{
    const io={fs:ports.fs??fs,uid:ports.uid??(typeof process.getuid==='function'?process.getuid():null),signal:ports.signal};
    const result=args[0]==='--build'?await buildReviewPackage({receipt_path:args[1],source_path:args[2],output_dir:args[3]},io):await verifyReviewPackage(args[1],io);
    if(result.status==='CORRUPT_OR_INCOMPLETE'){stderr.write('CORRUPT_OR_INCOMPLETE\n');return 2;}
    stdout.write('Squire local review package: '+(result.status==='VERIFIED'?'VERIFIED':'COMPLETE')+'\nSchema: squire3.package_manifest.v1\nManifest SHA256: '+result.manifest_sha256+'\nFiles: artifact.mjs, summary.json, README.txt, package-manifest.json\nOutcome: '+result.readiness_or_outcome+'\nTask correctness: '+result.task_correctness+'\nOriginal acknowledgement/provenance/crash durability are not proven by verification.\n');return result.exit_code;
  }catch(e){stderr.write(safePackageErrorCode(e)+'\n');return 2;}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)process.exitCode=await runPackageCli(process.argv.slice(2));
