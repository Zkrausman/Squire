import {publicFixtures,fixtureArgv} from './public-fixtures.mjs';
import {oracle,sha256,canonicalBytes} from './reference-summarizer.mjs';
// Pure freeze calculation. Caller owns physical publication; never spawns a program.
export function buildFreeze(){
  const paths={input_path:'/f/input.ndjson',output_path:'/f/summary.json',manifest_path:'/f/manifest.json'};
  return {schema:'Q218_PUBLIC_FIXTURE_FREEZE_V1',task:'ndjson-log-summarizer',runtime_admitted:false,
    oracle_role:'PUBLIC_REFERENCE_BYTE_TRANSFORM_NOT_GENERATED_SOLUTION',
    manifest_recipe:{manifest_version:'1.0',source_sha256:'BIND_ACTUAL_DELIVERED_SOURCE_AFTER_GENERATION',summary_bytes:'FROZEN_EXACT_BYTE_COUNT',summary_sha256:'FROZEN_EXACT_BYTES_SHA256',serialization:'ASCII_RECURSIVE_SORT_2_SPACES_FINAL_LF'},
    fixtures:publicFixtures().map(f=>{const argv=fixtureArgv(f.id,paths,f.window_start,f.window_end),r=oracle({...f,argv});return {
      fixture_id:`FIX-${String(f.id).padStart(2,'0')}`,input_bytes:f.input_bytes?.length??null,input_sha256:f.input_bytes?sha256(f.input_bytes):null,
      argv,expected_exit_code:r.exit_code,expected_summary_bytes:r.summary?.length??null,expected_summary_sha256:r.summary?sha256(r.summary):null,
      expected_summary_json:r.summary?JSON.parse(new TextDecoder().decode(r.summary)):null,zero_files_required:r.exit_code===2||r.exit_code===3};})};
}
export const freezeBytes=()=>canonicalBytes(buildFreeze());
