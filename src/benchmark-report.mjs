import { isDeepStrictEqual } from 'node:util';

export function summarizeTrace(events,{startedAt,endedAt}={}){
 const jobs=new Map();let rework=0;
 for(const event of events){
  if(event.type==='ticket.repair_started'||event.type==='ticket.correction_authorized'||(event.type==='ticket.transition'&&event.status==='repairing'))rework++;
  if(!event.jobId)continue;
  const job=jobs.get(event.jobId)??{id:event.jobId,role:event.role??'unknown',usage:null,outcome:null,requestedModel:event.requestedModel??null,requestedReasoning:event.requestedReasoning??null,reportedModel:event.reportedModel??null,reportedReasoning:event.reportedReasoning??null};
  if(event.role)job.role=event.role;
  if(event.requestedModel!==undefined)job.requestedModel=event.requestedModel;
  if(event.requestedReasoning!==undefined)job.requestedReasoning=event.requestedReasoning;
  if(event.reportedModel!==undefined)job.reportedModel=event.reportedModel;
  if(event.reportedReasoning!==undefined)job.reportedReasoning=event.reportedReasoning;
  if(event.usage){
    if(job.usage&&!isDeepStrictEqual(job.usage,event.usage))job.conflictingUsage=true;
    job.usage=event.usage;
  }
  if(event.type==='job.finished'){job.outcome=event.outcome;job.timedOut=event.timedOut===true||event.processStatus==='timed_out'||event.receipt?.timedOut===true;}
  jobs.set(event.jobId,job);
 }
 const metrics={sessions:jobs.size,sessionsByRole:{},timeouts:0,rework,unknownUsageSessions:0,pendingSessions:0,tokens:{input:0,cachedInput:0,noncachedInput:0,output:0,reasoningOutput:0},tokenTotalsComplete:true,cacheUsageIncomplete:false,reasoningUsageIncomplete:false,elapsedMs:Number.isFinite(startedAt)&&Number.isFinite(endedAt)&&endedAt>=startedAt?endedAt-startedAt:null};
 for(const job of jobs.values()){
  metrics.sessionsByRole[job.role]=(metrics.sessionsByRole[job.role]??0)+1;
  if(job.timedOut)metrics.timeouts++;
  if(!job.outcome){metrics.pendingSessions++;metrics.tokenTotalsComplete=false;}
  const u=job.usage;
  const count=value=>Number.isSafeInteger(value)&&value>=0;
  if(!u||job.conflictingUsage){
    if(job.outcome)metrics.unknownUsageSessions++;
    metrics.tokenTotalsComplete=false;metrics.cacheUsageIncomplete=true;metrics.reasoningUsageIncomplete=true;
    continue;
  }
  const hasIn=count(u.input_tokens),hasOut=count(u.output_tokens);
  const cacheValid=hasIn&&count(u.cached_input_tokens)&&u.cached_input_tokens<=u.input_tokens;
  if(hasIn)metrics.tokens.input+=u.input_tokens;
  if(hasOut)metrics.tokens.output+=u.output_tokens;
  if(cacheValid){
    metrics.tokens.cachedInput+=u.cached_input_tokens;
    metrics.tokens.noncachedInput+=u.input_tokens-u.cached_input_tokens;
  }else metrics.cacheUsageIncomplete=true;
  if(!hasIn||!hasOut||!cacheValid){
    if(job.outcome)metrics.unknownUsageSessions++;
    metrics.tokenTotalsComplete=false;
  }
  if(hasOut&&count(u.reasoning_output_tokens)&&u.reasoning_output_tokens<=u.output_tokens)metrics.tokens.reasoningOutput+=u.reasoning_output_tokens;
  else metrics.reasoningUsageIncomplete=true;

 }
 return {...metrics,tokenSemantics:'Known usage only; cached input is included in input and reasoning output is included in output. Unknown usage is not zero.',jobs:[...jobs.values()]};
}
export function calibrationReport({task,observations,processReceipt,trace=[],startedAt,endedAt}){
 const observed=processReceipt.exitCode===0&&!processReceipt.timedOut&&!processReceipt.stopped&&!processReceipt.outputExceeded&&observations?.newBehavior?.passed===true&&observations?.preservation?.passed===true;
 return {version:1,task,kind:'reference-control-calibration',scored:false,score:null,accepted:observed,newBehavior:observations?.newBehavior??{passed:false},preservation:observations?.preservation??{passed:false},processReceipt,metrics:summarizeTrace(trace,{startedAt,endedAt}),modelPerformanceMeasured:false,isolation:'Fresh subprocess for trusted local controls; not an OS security sandbox for adversarial candidates.'};
}
