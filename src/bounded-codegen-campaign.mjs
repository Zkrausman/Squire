import {observeGeneratedSyntax} from './limited-stream-collector.mjs';
import {verifyGeneratedFixture} from '../fixtures/q218/verify-result.mjs';

// Sequential source logic only: every side effect is an explicit port.
export async function runCodegenCampaign(config,ports){
 let last=-1;const now=()=>{const n=ports.clock.now();if(!Number.isSafeInteger(n)||n<0||n<last)throw Error('CLOCK_INVALID');last=n;if(ports.abortSignal?.aborted)throw Error('CANCELED');return n;};
 const cases=config.fixtures.map(f=>({fixture_id:f.fixture_id,status:'NOT_RUN'}));let generation=null,syntax=null,source=null,deadline=null;
 const result=(status,reason)=>Object.freeze({status,reason,generation,syntax,source,fixture_deadline_ms:deadline,fixtures:Object.freeze(cases.map(x=>Object.freeze({...x}))),
   denominator:17,runtime_admitted:false,workspace_disposition:status==='PASS'?'DEDICATED_NOT_REUSED':'QUARANTINED',descendant_guarantee:'NONE'});
 try{
  if(config.fixtures.length!==17)throw Error('FINITE_FIXTURE_MATRIX');
  if(ports.abortSignal?.aborted)return result('FAIL','CANCELED');
  generation=await ports.generate();
  if(generation.record.lifecycle_status!=='LIMITED_SUCCESS')return result('FAIL','GENERATION_REJECTED');
  source=await ports.inspectSource(generation.physical_source_witness);
  if(ports.abortSignal?.aborted)return result('FAIL','CANCELED');
  if(ports.abortSignal?.aborted)return result('FAIL','CANCELED');
  const raw=await ports.syntax(source);
  const accepted=raw.status==='OBSERVED_EXIT'&&raw.observed_termination===true&&raw.observed_exit_code===0&&raw.observed_exit_signal===null&&
    raw.io_state.io_drained===true&&raw.io_state.stdout_bytes_observed===0&&raw.io_state.stderr_bytes_observed===0&&raw.settlement_status==='SETTLED_DIRECT_CHILD_EXIT';
  syntax=Object.freeze({execution:raw,wrapper_status:'UNKNOWN',observation:observeGeneratedSyntax('')});
  if(!accepted)return result('FAIL','SYNTAX_PROCESS_REJECTED');
  const afterSyntax=await ports.inspectSource(generation.physical_source_witness);
  if(['source_sha256','source_path','source_byte_count'].some(k=>afterSyntax[k]!==source[k]))throw Error('SOURCE_IDENTITY_CHANGED');
  syntax=Object.freeze({execution:raw,wrapper_status:'ACCEPTED',observation:observeGeneratedSyntax('',{validateSyntax:()=>({syntax_status:'SYNTAX_VALID',syntax_valid:true})})});
  deadline=now()+85000;if(!Number.isSafeInteger(deadline))throw Error('CLOCK_OVERFLOW');
  for(let index=0;index<17;index++){
   if(ports.abortSignal?.aborted)return result('FAIL','CANCELED');
   const remaining=deadline-now();if(remaining<=0)return result('FAIL','AGGREGATE_EXPIRED');
   const fixture=config.fixtures[index];await ports.prepareFixture(fixture,index+1);
   if(ports.abortSignal?.aborted)return result('FAIL','CANCELED');
   const budget=deadline-now();if(budget<=0)return result('FAIL','AGGREGATE_EXPIRED');
   const execution=await ports.execute(fixture,index+1,Math.min(5000,budget),deadline);
   const observation=await ports.observeFixture(fixture,index+1,execution);
   const evaluation=verifyGeneratedFixture(fixture,observation,source.source_sha256);
   cases[index]={...evaluation,status:evaluation.fixture_verdict};
   if(ports.abortSignal?.aborted)return result('FAIL','CANCELED');
   if(now()>=deadline)return result('FAIL','AGGREGATE_EXPIRED');
   if(evaluation.fixture_verdict!=='PASS')return result('FAIL','FIXTURE_REJECTED');
  }
  return result('PASS',null);
 }catch{return result('FAIL',ports.abortSignal?.aborted?'CANCELED':'OPERATION_FAILED_OR_UNCERTAIN');}
}
