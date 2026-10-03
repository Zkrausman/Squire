export function summarizeTrace(events,{startedAt,endedAt}={}){
 const jobs=new Map();let rework=0;
 for(const event of events){
  if(event.type==='ticket.repair_started'||event.type==='ticket.correction_authorized'||(event.type==='ticket.transition'&&event.status==='repairing'))rework++;
  if(!event.jobId)continue;
  const job=jobs.get(event.jobId)??{id:event.jobId,role:event.role??'unknown',usage:null,outcome:null};
  if(event.role)job.role=event.role;
  if(event.usage){if(job.usage&&JSON.stringify(job.usage)!==JSON.stringify(event.usage))job.conflictingUsage=true;job.usage=event.usage;}
  if(event.type==='job.finished'){job.outcome=event.outcome;job.timedOut=event.timedOut===true||event.processStatus==='timed_out'||event.receipt?.timedOut===true;}
  jobs.set(event.jobId,job);
 }
 const metrics={sessions:jobs.size,sessionsByRole:{},timeouts:0,rework,unknownUsageSessions:0,pendingSessions:0,tokens:{input:0,cachedInput:0,noncachedInput:0,output:0,reasoningOutput:0},tokenTotalsComplete:true,elapsedMs:Number.isFinite(startedAt)&&Number.isFinite(endedAt)&&endedAt>=startedAt?endedAt-startedAt:null};
 for(const job of jobs.values()){
  metrics.sessionsByRole[job.role]=(metrics.sessionsByRole[job.role]??0)+1;
  if(job.timedOut)metrics.timeouts++;
  if(!job.outcome)metrics.pendingSessions++;
  const u=job.usage,valid=u&&!job.conflictingUsage&&['input_tokens','cached_input_tokens','output_tokens'].every(k=>Number.isSafeInteger(u[k])&&u[k]>=0)&&u.cached_input_tokens<=u.input_tokens;
  if(!valid){if(job.outcome)metrics.unknownUsageSessions++;metrics.tokenTotalsComplete=false;continue;}
  metrics.tokens.input+=u.input_tokens;metrics.tokens.cachedInput+=u.cached_input_tokens;metrics.tokens.noncachedInput+=u.input_tokens-u.cached_input_tokens;metrics.tokens.output+=u.output_tokens;
  if(Number.isSafeInteger(u.reasoning_output_tokens)&&u.reasoning_output_tokens>=0)metrics.tokens.reasoningOutput+=u.reasoning_output_tokens;
  else metrics.reasoningUsageIncomplete=true;
 }
 return {...metrics,tokenSemantics:'Known usage only; cached input is included in input and reasoning output is included in output. Unknown usage is not zero.',jobs:[...jobs.values()]};
}
export function calibrationReport({task,observations,processReceipt,trace=[],startedAt,endedAt}){
 const observed=processReceipt.exitCode===0&&!processReceipt.timedOut&&!processReceipt.stopped&&!processReceipt.outputExceeded&&observations?.newBehavior?.passed===true&&observations?.preservation?.passed===true;
 return {version:1,task,kind:'reference-control-calibration',scored:false,score:null,accepted:observed,newBehavior:observations?.newBehavior??{passed:false},preservation:observations?.preservation??{passed:false},processReceipt,metrics:summarizeTrace(trace,{startedAt,endedAt}),modelPerformanceMeasured:false,isolation:'Fresh subprocess for trusted local controls; not an OS security sandbox for adversarial candidates.'};
}
