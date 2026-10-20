import {expectedManifest,sha256} from './reference-summarizer.mjs';
// Pure equality against public frozen expectations. The caller supplies observations;
// this function attests no filesystem custody, native parser or safe execution.
export function verifyGeneratedFixture(fixture,observation,source_sha256){
  const execution=observation.execution,goodExit=execution.observed_termination===true&&execution.observed_exit_code===fixture.expected_exit_code&&execution.observed_exit_signal===null;
  const settled=execution.settlement_status==='SETTLED_DIRECT_CHILD_EXIT'&&execution.io_state.io_drained===true&&execution.status==='OBSERVED_EXIT';
  let summary='NOT_APPLICABLE',manifest='NOT_APPLICABLE',zero='NOT_APPLICABLE';
  if(fixture.expected_exit_code===0){
    const bytes=observation.summary_bytes;
    summary=bytes instanceof Uint8Array&&bytes.length===fixture.expected_summary_bytes&&sha256(bytes)===fixture.expected_summary_sha256;
    manifest=summary&&observation.manifest_bytes instanceof Uint8Array&&sha256(observation.manifest_bytes)===sha256(expectedManifest(source_sha256,bytes));
  }else if(fixture.zero_files_required){zero=observation.summary_absent===true&&observation.manifest_absent===true;}
  return Object.freeze({fixture_id:fixture.fixture_id,observed_exit_code:execution.observed_exit_code,observed_exit_signal:execution.observed_exit_signal,
    observed_wall_ms:execution.observed_wall_ms,exit_code_matched:goodExit,summary_json_matched:summary,manifest_json_matched:manifest,zero_files_verified:zero,
    fixture_verdict:execution.status==='TIMEOUT'?'TIMEOUT':goodExit&&settled&&summary!==false&&manifest!==false&&zero!==false?'PASS':'FAIL'});
}
