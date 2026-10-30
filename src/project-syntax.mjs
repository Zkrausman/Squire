import {executePreparedProjectSyntax} from './limited-generated-executor.mjs';

// Explicit injected execution only. No filesystem access, native defaults,
// generated-code import, source identity verification or admission is supplied.
export function executeProjectSyntax(spec,ports){
  return executePreparedProjectSyntax(spec,ports);
}
