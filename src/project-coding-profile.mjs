// Fixed source-only selection data. No launcher, filesystem or provider access.
import {closed,fail} from './job-spec.mjs';

export const PROJECT_CODING_OBSERVATION_PROFILE=Object.freeze({
  id:'PROJECT_CODING_OBSERVE_V1',
  generation_wall_ms:null,
  outer_observation_ms:null,
  post_generation_closeout_ms:20000
});
export const PROJECT_CODING_OBSERVATION_CONFIG_SCHEMA='SQUIRE2_DESKTOP_CODING_OBSERVATION_OPERATION_V1';
export const PROJECT_CODING_OBSERVATION_MANIFEST_SCHEMA='SQUIRE2_DESKTOP_CODING_OBSERVATION_PREPARED_MANIFEST_V1';
export const PROJECT_CODING_OBSERVATION_RESULT_SCHEMA='SQUIRE2_PROJECT_CODING_OBSERVATION_RESULT_V1';
export const PROJECT_CODING_OBSERVATION_RECEIPT_SCHEMA='SQUIRE3_NATIVE_PROJECT_CODING_OBSERVATION_RESULT_RECEIPT_V1';
export const PROJECT_CODING_OBSERVATION_SUMMARY_SCHEMA='squire3.native_project_coding_observation_summary.v1';

const legacy=Object.freeze({
  generation_wall_ms:120000,outer_observation_ms:140000,
  post_generation_closeout_ms:null
});
export function validateProjectCodingObservationProfile(value){
  const keys=['id','generation_wall_ms','outer_observation_ms','post_generation_closeout_ms'];
  closed(value,keys,[],'project_coding_observation_profile');
  for(const key of keys){
    if(value[key]!==PROJECT_CODING_OBSERVATION_PROFILE[key])fail('project_coding_observation_profile');
  }
  return PROJECT_CODING_OBSERVATION_PROFILE;
}
// Absence selects only the historical bounds. Callers additionally bind their
// closed schema, target and execution mode before using this resolution.
export function resolveProjectCodingProfile(value){
  return value===undefined?legacy:validateProjectCodingObservationProfile(value);
}

const observationRejections=new Set([
  'LIMITED_PROCESS_FAILED','LIMITED_CAPACITY_EXCEEDED','LIMITED_PARSER_ERROR',
  'LIMITED_SPAWN_FAILED','LIMITED_PERSISTENCE_FAILED','LIMITED_INTERNAL_ERROR'
]);
const observationStagingErrors=new Set([
  'DESTINATION_ALREADY_EXISTS','SOURCE_NOT_FOUND','SOURCE_INTEGRITY_MISMATCH',
  'STAGE_INTEGRITY_MISMATCH','STAGE_BINDING_MISMATCH','INVALID_STAGE_SPEC',
  'INVALID_EXPORT_SPEC','INVALID_MANIFEST','SPECIAL_FILE_REJECTED',
  'PATH_TRAVERSAL_REJECTED','PATH_COLLISION_REJECTED','CAPACITY_EXCEEDED',
  'PRIVACY_VIOLATION_REJECTED','PACKAGE_IO_ERROR','PACKAGE_ABORTED'
]);
// The producer and both offline validation paths use this same closed matrix.
// It validates outcome relationships, not the underlying generation or ACK.
export function validateProjectCodingObservationOutcome(value){
  closed(value,[
    'status','reason','lifecycle','generation_invocations','has_staging',
    'post_generation_closeout'
  ],[],'project_coding_observation_outcome');
  const {
    status,reason,lifecycle,generation_invocations:count,has_staging:ack,
    post_generation_closeout:closeout
  }=value;
  closed(closeout,['status','limit_ms'],[],'project_coding_observation_closeout');
  if(closeout.limit_ms!==PROJECT_CODING_OBSERVATION_PROFILE.post_generation_closeout_ms||
     !Number.isSafeInteger(count)||count<0||count>1||typeof ack!=='boolean'){
    fail('project_coding_observation_outcome');
  }
  const state=closeout.status;
  let valid=false;
  if(lifecycle===null){
    valid=count===0&&!ack&&state==='NOT_STARTED'&&(
      status==='INCOMPLETE'&&reason==='CANCELED'||
      status==='FAILED'&&reason==='OPERATION_FAILED_OR_UNCERTAIN'
    );
  }else if(lifecycle==='LIMITED_USER_ABORT'||observationRejections.has(lifecycle)){
    // Before a spawn attempt, only an actual abort or internal setup error can
    // produce a generation record. A spawn failure records the attempted call.
    const countValid=count===1||count===0&&
      ['LIMITED_USER_ABORT','LIMITED_INTERNAL_ERROR'].includes(lifecycle);
    valid=countValid&&!ack&&state==='NOT_STARTED'&&(
      status==='INCOMPLETE'&&reason==='CANCELED'||
      status==='GENERATION_REJECTED'&&reason==='GENERATION_REJECTED'&&
        observationRejections.has(lifecycle)
    );
  }else if(lifecycle==='LIMITED_SUCCESS'&&count===1){
    switch(status){
      case 'CANDIDATE_STAGED':
        valid=reason===null&&ack&&state==='COMPLETE';
        break;
      case 'STAGING_REJECTED':
        valid=!ack&&state==='FAILED_OR_UNCERTAIN'&&typeof reason==='string'&&
          reason.startsWith('STAGING:')&&observationStagingErrors.has(reason.slice(8));
        break;
      case 'INCOMPLETE':
        if(reason==='CANCELED'){
          valid=state==='CANCELED'||state==='NOT_STARTED'&&!ack;
        }else if(reason==='POST_GENERATION_CLOSEOUT_DEADLINE'){
          valid=state==='DEADLINE_EXCEEDED';
        }
        break;
      case 'FAILED':
        if(reason==='CLEANUP_FAILED_OR_UNCERTAIN'){
          // Cleanup can fail after cancellation or expiry. Preserve that
          // history; a deadline failure before ACK cannot invent an ACK.
          valid=['FAILED_OR_UNCERTAIN','CANCELED'].includes(state)||
            state==='DEADLINE_EXCEEDED'&&!ack;
        }else if(reason==='CLOCK_UNAVAILABLE'){
          valid=ack&&['FAILED_OR_UNCERTAIN','CANCELED'].includes(state);
        }else if(reason==='OPERATION_FAILED_OR_UNCERTAIN'){
          // Cancellation may reenter a failing closeout's timer cleanup.
          valid=!ack&&['NOT_STARTED','FAILED_OR_UNCERTAIN','CANCELED'].includes(state);
        }
        break;
    }
  }
  if(!valid)fail('project_coding_observation_outcome');
  return Object.freeze({status:state,limit_ms:closeout.limit_ms});
}
