// Explicit offline portable-candidate snapshot commands only.
import {pathToFileURL} from 'node:url';
import {runProjectPortableCandidateSnapshotCli} from '../src/project-portable-candidate-snapshot.mjs';

export {runProjectPortableCandidateSnapshotCli};

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  let outputFailed=false;
  const outputError=()=>{outputFailed=true;process.exitCode=2;};
  process.stdout.on('error',outputError);process.stderr.on('error',outputError);
  const code=await runProjectPortableCandidateSnapshotCli(process.argv.slice(2));
  process.exitCode=outputFailed?2:code;
}
