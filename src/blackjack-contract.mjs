// Pure bounded source-controller data validation. No provider or native imports.
import {types} from 'node:util';
import {isAbsolute,normalize} from 'node:path';
import {closed,ContractError} from './job-spec.mjs';
import {parseProjectJson} from './project-task.mjs';
import {planStaging} from './multifile-staging.mjs';
import {canonicalBytes,hash} from './bounded-codegen-plan.mjs';
export const BLACKJACK_BRIEF_SHA256='bee5f85f411b9f087d4e3de08531c7c00247ce42f64e7afc4aad7bcaacf6aad7';
export const BLACKJACK_BASE=Object.freeze({commit:'2e1bf2dbe4bc034982c0376e65d0b530ee9484bc',tree:'100fd72548b6c2c288e8177bf8f23089214a2207'});
export const BLACKJACK_PHASES=Object.freeze(['phase_0_preparation_and_pin_verification','phase_1_autonomous_interpretation_and_host_ack','phase_2_candidate_implementation_staging','phase_3_logic_and_automated_unit_verification','phase_4_headless_display_gui_verification','phase_5_independent_review_and_delivery_packaging']);
export class BlackjackControllerError extends ContractError{constructor(code){super(code,'blackjack_controller');this.message=code;delete this.stack;}}
export const rejectBlackjack=code=>{throw new BlackjackControllerError(code);};
export const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v);
export const integer=v=>Number.isSafeInteger(v)&&v>=0;
export const sha=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
export const absolute=v=>typeof v==='string'&&isAbsolute(v)&&v!=='/'&&normalize(v)===v&&!/[\\\x00-\x1f\x7f]/u.test(v);
export function byteCopy(v,max=65536){if(types.isProxy(v)||!types.isUint8Array(v)||Object.getPrototypeOf(v)!==Uint8Array.prototype)rejectBlackjack('INVALID_BYTES');const n=Reflect.apply(Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype),'byteLength').get,v,[]);if(n>max)rejectBlackjack('INVALID_BYTES');return new Uint8Array(v);}
export function freezeData(v){if(v&&typeof v==='object'){for(const c of Object.values(v))freezeData(c);Object.freeze(v);}return v;}
export function validateBlackjackSpec(input){
 const required=['schema','run_id','workspace_root','source_commit','source_tree','requested_model','effort','max_cumulative_wallclock_sec','cleanup_reserve_ms','max_model_invocations','max_native_jobs','max_live_owned_processes','per_call_generation_wall_ms','per_call_observation_wall_ms'];
 try{closed(input,required,['fenced_history_ref'],'controller_spec');}catch{rejectBlackjack('INVALID_CONTROLLER_SPEC');}
 if(input.per_call_generation_wall_ms!==120000||input.per_call_observation_wall_ms!==140000)rejectBlackjack('INVALID_CALL_CLOCK');
 if(input.schema!=='SQUIRE_BLACKJACK_CONTROLLER_SPEC_V1'||!uuid(input.run_id)||!absolute(input.workspace_root)||input.source_commit!==BLACKJACK_BASE.commit||input.source_tree!==BLACKJACK_BASE.tree||input.cleanup_reserve_ms!==30000)rejectBlackjack('INVALID_CONTROLLER_SPEC');
 for(const [k,min,max] of [['max_cumulative_wallclock_sec',170,2400],['max_model_invocations',1,10],['max_native_jobs',1,3],['max_live_owned_processes',1,8]])if(!integer(input[k])||input[k]<min||input[k]>max)rejectBlackjack('INVALID_CONTROLLER_SPEC');
 if(typeof input.requested_model!=='string'||!/^[a-zA-Z0-9._-]{1,128}$/.test(input.requested_model)||!['none','minimal','low','medium','high','xhigh','max','ultra'].includes(input.effort)||Object.hasOwn(input,'fenced_history_ref')&&(typeof input.fenced_history_ref!=='string'||!/^[a-zA-Z0-9._-]{1,128}$/.test(input.fenced_history_ref)))rejectBlackjack('INVALID_CONTROLLER_SPEC');
 return Object.freeze({...input});
}
export function parseBlackjackInterpretation(input){
 const bytes=byteCopy(input);if(bytes.length<512)rejectBlackjack('INVALID_INTERPRETATION_WIRE');let w;
 try{w=parseProjectJson(bytes,65536);closed(w,['schema','interpretation_id','brief_page_sha256','concept_summary','blackjack_mechanic_integration','shooter_combat_loop','visual_and_audio_aesthetic','rule_set_specification','planned_file_manifest','verification_strategy'],[],'interpretation');}catch{rejectBlackjack('INVALID_INTERPRETATION_WIRE');}
 if(w.schema!=='SQUIRE_BLACKJACK_INTERPRETATION_WIRE_V1'||!uuid(w.interpretation_id)||w.brief_page_sha256!==BLACKJACK_BRIEF_SHA256)rejectBlackjack('INVALID_INTERPRETATION_WIRE');
 for(const [k,min,max] of [['concept_summary',50,2048],['blackjack_mechanic_integration',50,4096],['shooter_combat_loop',50,4096],['visual_and_audio_aesthetic',20,2048],['rule_set_specification',50,4096],['verification_strategy',50,2048]])if(typeof w[k]!=='string'||w[k].length<min||w[k].length>max||/[\x00-\x1f\x7f-\x9f\uFEFF\uD800-\uDFFF]/u.test(w[k]))rejectBlackjack('INVALID_INTERPRETATION_WIRE');
 // Parsed arrays are data-only. PR176 supplies portable relative paths and collision rules.
 try{if(!Array.isArray(w.planned_file_manifest)||w.planned_file_manifest.length<1)throw 0;planStaging({stage_operation_id:'interpretation-validation',caller_label:'blackjack',files:w.planned_file_manifest.map((path,index)=>({path,classification:index<25?'SOURCE':index<45?'LOCAL_ASSET':'DOC',content:new Uint8Array()}))});}catch{rejectBlackjack('INVALID_INTERPRETATION_WIRE');}
 const canonical=canonicalBytes(w);if(canonical.length<512||canonical.length>65536)rejectBlackjack('INVALID_INTERPRETATION_WIRE');return {wire:freezeData(w),bytes:canonical,sha256:hash(canonical)};
}
export const BLACKJACK_BASE_SOURCE_PINS=Object.freeze([{"path":"src/project-task.mjs","bytes":8012,"sha256":"320face742f4ad27b658d82ce1ae8964462c2a817a0c0b1d48411eaf17f03b9f"},{"path":"src/project-configuration.mjs","bytes":9533,"sha256":"ada944f19ae16e2c29d2c2ef00fc6ddfc8978d505c455d917418a7d49e474805"},{"path":"src/project-runner.mjs","bytes":9737,"sha256":"3caae877c8525cfa6a01099876ed77afd54ec5f9621cf2654e301dbe2c4f20a2"},{"path":"src/project-stream-collector.mjs","bytes":5330,"sha256":"78432960c22b0bc13906825ba5d6097fad174943c7eabcea8b0184ae4785f2ce"},{"path":"acceptance/prepare-project-task.mjs","bytes":1010,"sha256":"85cd902f5b8489c581740cd7b4e03c34fa74a255b6b0ef3e0f9d44672c357292"},{"path":"acceptance/project-entrypoint.mjs","bytes":4127,"sha256":"1a5bdbdd0059fe13942bfcc4d6fd29ff13ca1bccf6134e1a41fa99da7b51774f"},{"path":"src/multifile-staging.mjs","bytes":127,"sha256":"ade7afc17829df66713054fa1c59360e35b4c1de5a2bf60b90f34929f8d2faf2"},{"path":"src/multifile-export.mjs","bytes":140,"sha256":"ece01ab3b9bf3c80fd631dffe79b11745b2b8e48d4e88a1300578c066b52d345"},{"path":"src/internal/multifile-core.mjs","bytes":23235,"sha256":"5ff1c193a2147c6154fe43be14584fe2e6fba081e7187c46173b447d3278d420"},{"path":"src/codex-profile.mjs","bytes":3030,"sha256":"97a1b91463a3bdffed7ac2b81f1f38d0cb4e353a07d8590fdd7726e4dcdc6c13"},{"path":"src/job-spec.mjs","bytes":3603,"sha256":"b0a79ac59296ea8b32a29c8653ea930985b9a63cea36e8f5fd8dbe2f8ccdda8a"},{"path":"test/project.test.mjs","bytes":21714,"sha256":"5405ee48452aae8454397961de9ba982da9bbfb130bf5fd49a9a7db63cb845ee"},{"path":"docs/project-candidates.md","bytes":6401,"sha256":"3694e40d2a9a8991155add5ad5857bcdb4915c6f1d8c3aa1fca16c1fffc2a270"}].map(Object.freeze));
