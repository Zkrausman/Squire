// Explicit offline candidate import only. Importing this file is inert.
import {pathToFileURL} from 'node:url';
import {runProjectReviewCandidateCli} from '../src/project-review-candidate.mjs';

export {runProjectReviewCandidateCli};

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  process.exitCode=await runProjectReviewCandidateCli(process.argv.slice(2));
}
