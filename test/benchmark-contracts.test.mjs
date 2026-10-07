import test from './standalone.mjs';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import {readFile,mkdtemp,readdir,writeFile,mkdir,symlink,link,unlink,lstat,rm} from 'node:fs/promises';
import {materializeTask,validateTask,toSquireTicket,toSquireProject} from '../benchmarks/contracts/task.mjs';
// Inert synthetic markers exercise file boundaries; no grader or answer is executed.
const task={version:1,id:'public-fixture',goal:'Update the public fixture module.',publicRoot:'public',privateRoot:'private',
 seedFiles:['fixture.mjs'],grader:'grader.txt',references:['reference.txt'],environment:{nodeMajor:24,platforms:['win32','linux'],authentication:'subscription'},
 budget:{maxSessions:4,jobTimeoutSeconds:900},acceptance:['Observe new behavior.','Preserve existing behavior.'],ownedPaths:['fixture.mjs']};
async function syntheticCase(t){
 const root=await mkdtemp(path.join(os.tmpdir(),'squire-case-'));
 t.after(()=>import('node:fs/promises').then(({rm})=>rm(root,{recursive:true,force:true})));
 await mkdir(path.join(root,'public'));await mkdir(path.join(root,'private'));
 await writeFile(path.join(root,'public/fixture.mjs'),'export const fixture = true;\n');
 await writeFile(path.join(root,'private/grader.txt'),'INERT_PRIVATE_GRADER_MARKER');
 await writeFile(path.join(root,'private/reference.txt'),'INERT_PRIVATE_REFERENCE_MARKER');
 return root;
}
test('public materialization excludes private markers and locations; adapter uses existing contracts',async t=>{
 const caseRoot=await syntheticCase(t);
 const temp=await mkdtemp(path.join(os.tmpdir(),'squire-public-'));
 const prepared=await materializeTask(task,caseRoot,path.join(temp,'worker'));
 assert.deepEqual((await readdir(prepared.workspace)).sort(),['fixture.mjs','goal.txt','task-public.json']);
 const publicText=await readFile(path.join(prepared.workspace,'task-public.json'),'utf8');
 for(const marker of ['private','grader','reference.txt','INERT_PRIVATE'])assert.ok(!publicText.includes(marker));
 assert.equal(prepared.manifest.length,1);
 await assert.rejects(materializeTask(task,caseRoot,prepared.workspace),/already exists/);
 const services={app:{source:path.join(temp,'local.git'),branch:'main',delivery:{kind:'local'},checks:[{name:'behavior',argv:[process.execPath,'test.mjs'],timeoutSeconds:10}]}};
 const ticket=toSquireTicket(task,'app',services);assert.equal(ticket.execution.checklist.length,2);assert.equal(ticket.execution.maxAttempts,2);
 const project=toSquireProject(task,{version:1,id:'arithmetic-control',stateDir:path.join(temp,'state'),services,runtime:{kind:'codex',authentication:'subscription'},limits:{maxAgentCalls:10,agentTimeoutSeconds:1000}},'app');
 assert.equal(project.limits.maxAgentCalls,4);assert.equal(project.limits.agentTimeoutSeconds,900);
});
test('traversal, overlapping roots, Windows aliases and duplicate paths fail closed',()=>{
 for(const edit of [{id:undefined},{id:[]},{seedFiles:['../private/correct.mjs']},{seedFiles:['C:/secret']},{seedFiles:['foo\\bar']},{seedFiles:['x','X']},{privateRoot:'public/private'},{ownedPaths:['../outside']},{budget:{maxSessions:0,jobTimeoutSeconds:900}}])assert.throws(()=>validateTask({...task,...edit}));
});
test('linked public file cannot leak a private control',async()=>{
 const temp=await mkdtemp(path.join(os.tmpdir(),'squire-link-'));await mkdir(path.join(temp,'public'));await mkdir(path.join(temp,'private'));
 await writeFile(path.join(temp,'private/grader.txt'),'INERT_PRIVATE_GRADER_MARKER');await writeFile(path.join(temp,'private/reference.txt'),'INERT_PRIVATE_REFERENCE_MARKER');
 await symlink(path.join(temp,'private/reference.txt'),path.join(temp,'public/fixture.mjs'));
 await assert.rejects(materializeTask(task,temp,path.join(path.dirname(temp),path.basename(temp)+'-worker')),/Symlink/);
});
test('hardlinked public seed cannot copy private reference bytes or create a workspace',async t=>{
 const root=await syntheticCase(t),scratch=await mkdtemp(path.join(os.tmpdir(),'squire-hardlink-'));
 t.after(()=>rm(scratch,{recursive:true,force:true}));
 const source=path.join(root,'public/fixture.mjs'),reference=path.join(root,'private/reference.txt');
 await unlink(source);await link(reference,source);
 assert.equal((await lstat(source)).nlink,2);
 const destination=path.join(scratch,'worker');
 await assert.rejects(materializeTask(task,root,destination),/Hardlinked input rejected/);
 await assert.rejects(lstat(destination),{code:'ENOENT'});
 assert.equal(await readFile(reference,'utf8'),'INERT_PRIVATE_REFERENCE_MARKER');
});
