import path from 'node:path';
import {lstat,realpath,readFile,mkdir,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {validateTickets,validateConfig} from '../../src/contracts.mjs';
const inside=(root,file)=>file===root||(!path.relative(root,file).startsWith('..'+path.sep)&&!path.isAbsolute(path.relative(root,file))&&path.relative(root,file)!=='..');
const relative=value=>typeof value==='string'&&value.length>0&&!value.includes('\\')&&!value.includes(':')&&!value.includes('\0')&&!path.posix.isAbsolute(value)&&value.split('/').every(p=>p!=='.'&&p!=='..'&&p.length>0);
const requireValue=(ok,message)=>{if(!ok)throw new Error(message);};
export function validateTask(task){
 requireValue(task?.version===1&&typeof task.id==='string'&&task.id.length<=80&&/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(task.id),'Invalid task identity');
 requireValue(typeof task.goal==='string'&&task.goal.trim().length>0,'Missing public goal');
 requireValue(relative(task.publicRoot)&&relative(task.privateRoot),'Roots must be relative safe paths');
 requireValue(!inside(task.publicRoot,task.privateRoot)&&!inside(task.privateRoot,task.publicRoot),'Public/private roots must be disjoint');
 requireValue(Array.isArray(task.seedFiles)&&task.seedFiles.length>0&&task.seedFiles.every(relative),'Seed files must be explicit safe relative files');
 requireValue(new Set(task.seedFiles.map(p=>p.toLowerCase())).size===task.seedFiles.length,'Duplicate seed file');
 requireValue(!task.seedFiles.some(p=>['task-public.json','goal.txt'].includes(p.toLowerCase())),'Reserved public file');
 requireValue(relative(task.grader)&&Array.isArray(task.references)&&task.references.length>0&&task.references.every(relative),'Private grader and references must be relative');
 requireValue(task.environment?.nodeMajor===24&&Array.isArray(task.environment.platforms)&&task.environment.platforms.includes('win32')&&task.environment.authentication==='subscription','Native environment identity required');
 for(const key of ['maxSessions','jobTimeoutSeconds'])requireValue(Number.isSafeInteger(task.budget?.[key])&&task.budget[key]>0,'Invalid fixed budget');
 requireValue(Array.isArray(task.acceptance)&&task.acceptance.length>0&&task.acceptance.every(s=>typeof s==='string'&&s.trim()),'Acceptance required');
 requireValue(Array.isArray(task.ownedPaths)&&task.ownedPaths.length>0&&task.ownedPaths.every(relative),'Owned paths required');
 return structuredClone(task);
}
async function safeFile(root,relativePath){
 let current=root;
 for(const segment of relativePath.split('/')){current=path.join(current,segment);const info=await lstat(current);requireValue(!info.isSymbolicLink(),'Symlink input rejected');}
 const canonical=await realpath(current);requireValue(inside(root,canonical),'Input escapes root');
 const info=await lstat(canonical);
 requireValue(info.isFile(),'Input must be a regular file');
 requireValue(info.nlink===1,'Hardlinked input rejected');return canonical;
}
export async function materializeTask(input,caseRoot,destination){
 const task=validateTask(input),root=await realpath(caseRoot);
 const publicRoot=await realpath(path.join(root,task.publicRoot)),privateRoot=await realpath(path.join(root,task.privateRoot));
 requireValue(inside(root,publicRoot)&&inside(root,privateRoot)&&!inside(publicRoot,privateRoot)&&!inside(privateRoot,publicRoot),'Canonical public/private roots must be disjoint and contained');
 const parent=await realpath(path.dirname(path.resolve(destination))),target=path.join(parent,path.basename(destination));
 requireValue(!inside(root,target)&&!inside(target,root),'Destination must be outside case inputs');
 try{await lstat(target);throw Error('Destination already exists');}catch(error){if(error.code!=='ENOENT')throw error;}
 // Resolve and read every allowed public file before creating the destination.
 const files=await Promise.all(task.seedFiles.map(async file=>({file,bytes:await readFile(await safeFile(publicRoot,file))})));
 await safeFile(privateRoot,task.grader);for(const reference of task.references)await safeFile(privateRoot,reference);
 await mkdir(target,{recursive:false});
 for(const {file,bytes} of files){await mkdir(path.dirname(path.join(target,file)),{recursive:true});await writeFile(path.join(target,file),bytes,{flag:'wx'});}
 const publicTask={version:task.version,id:task.id,goal:task.goal,environment:task.environment,budget:task.budget,acceptance:task.acceptance,ownedPaths:task.ownedPaths};
 await writeFile(path.join(target,'task-public.json'),JSON.stringify(publicTask,null,2)+'\n',{flag:'wx'});
 await writeFile(path.join(target,'goal.txt'),task.goal+'\n',{flag:'wx'});
 return {workspace:target,publicTask,manifest:files.map(({file,bytes})=>({path:file,sha256:createHash('sha256').update(bytes).digest('hex')}))};
}
export function toSquireTicket(input,service,services){
 const task=validateTask(input);
 const ticket={id:task.id,service,title:task.goal,description:task.goal,acceptance:task.acceptance,dependsOn:[],execution:{version:1,outcome:task.goal,ownedPaths:task.ownedPaths,contextPaths:[],invariants:['Keep existing behavior and source inputs unchanged.'],checklist:task.acceptance.map((assertion,i)=>({id:`behavior-${i+1}`,assertion,steps:['Run the configured trusted behavioral checks at the exact candidate.'],evidence:'Observed trusted-check output at the exact candidate.'})),stopWhen:'Complete the accepted outcome within the fixed budget.',maxAttempts:Math.min(2,task.budget.maxSessions)}};
 return validateTickets([ticket],services)[0];
}
export function toSquireProject(input,base,service){
 const task=validateTask(input);
 const ticket=toSquireTicket(task,service,base.services);
 const config=validateConfig({...structuredClone(base),tickets:[ticket]});
 requireValue(config.runtime.authentication===task.environment.authentication,'Authentication identity mismatch');
 config.limits.maxAgentCalls=Math.min(config.limits.maxAgentCalls,task.budget.maxSessions);
 config.limits.agentTimeoutSeconds=Math.min(config.limits.agentTimeoutSeconds,task.budget.jobTimeoutSeconds);
 return validateConfig(config);
}
