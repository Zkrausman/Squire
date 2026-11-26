// Synthetic saved observations derived from the public freeze. No fixture execution.
import freeze from '../../fixtures/q218/fixtures-freeze-manifest.json' with {type:'json'};

export function passingQ218Rows(){
  return freeze.fixtures.map(fixture=>({
    fixture_id:fixture.fixture_id,
    status:'PASS',
    fixture_verdict:'PASS',
    observed_exit_code:fixture.expected_exit_code,
    observed_exit_signal:null,
    observed_wall_ms:0,
    exit_code_matched:true,
    summary_json_matched:fixture.expected_exit_code===0?true:'NOT_APPLICABLE',
    manifest_json_matched:fixture.expected_exit_code===0?true:'NOT_APPLICABLE',
    zero_files_verified:fixture.zero_files_required?true:'NOT_APPLICABLE'
  }));
}
