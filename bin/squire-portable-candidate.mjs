// Explicit offline portable-candidate snapshot commands only.
import {pathToFileURL} from 'node:url';
import {runProjectPortableCandidateSnapshotCli} from '../src/project-portable-candidate-snapshot.mjs';

export {runProjectPortableCandidateSnapshotCli};

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  process.exitCode=await runProjectPortableCandidateSnapshotCli(process.argv.slice(2));
}
