// Explicit offline candidate import only. Importing this file is inert.
import {pathToFileURL} from 'node:url';
import {runProjectReviewCandidateCli} from '../src/project-review-candidate.mjs';

export {runProjectReviewCandidateCli};

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  // Executable lifetime only: observe errors without retrying output or artifacts.
  let outputFailed=false;
  const outputError=()=>{outputFailed=true;process.exitCode=2;};
  process.stdout.on('error',outputError);process.stderr.on('error',outputError);
  const code=await runProjectReviewCandidateCli(process.argv.slice(2));
  process.exitCode=outputFailed?2:code;
}
