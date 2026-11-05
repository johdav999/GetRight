// Actual queue worker, owned run children and browsers; disposable demo only.
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, expect } from '@playwright/test';
import { api, repositoryRoot } from '../src/settings.mjs';
import { cleanEnvironment, stopProcess, boundedLog } from '../src/processes.mjs';
import { RunSessions } from '../src/run-sessions.mjs';
import { dashboardHost } from './dashboard-host.mjs';

const dataPath=path.join(repositoryRoot,'.local',`independent-reviews-${Date.now()}`),dashboard=await dashboardHost(dataPath),origin=dashboard.origin;
const get=route=>api(origin,route),queue=(stepByStep=false)=>api(origin,'/api/runs',{testId:'getright-save-note',docked:true,stepByStep});
const until=async(check,message,timeout=30000)=>{const end=Date.now()+timeout;while(Date.now()<end){const value=await check();if(value)return value;await delay(150);}throw new Error(message);};
const state=id=>get(`/api/runs/${id}/browser`),stored=id=>get(`/api/runs/${id}`);
const review=async id=>until(async()=>{const s=await state(id);return s.phase==='review'&&s;},`Review did not open for ${id}`);
const frozen=async id=>({run:await stored(id),trace:createHash('sha256').update(await readFile(path.join(dataPath,'evidence',id,'trace.zip'))).digest('hex')});
const report={scope:'Independent completed review/queue processes, pending acceptance and saved immutable evidence; no providers',flows:[]};
let worker,browser,sessions;
const launch=()=>{
 const child=fork(fileURLToPath(new URL('../src/index.mjs',import.meta.url)),[],{env:{...cleanEnvironment(),GETRIGHT_DASHBOARD_URL:origin,GETRIGHT_DATA_PATH:dataPath,GETRIGHT_HEADLESS:'true'},execArgv:[],windowsHide:true,detached:process.platform!=='win32',stdio:['ignore','pipe','pipe','ipc']});
 child.stdout.on('data',boundedLog(path.join(dataPath,`worker-${child.pid}-stdout.log`)));child.stderr.on('data',boundedLog(path.join(dataPath,`worker-${child.pid}-stderr.log`)));return child;
};
const stop=async()=>{if(!worker)return;const exit=new Promise(resolve=>worker.once('exit',resolve));if(worker.connected)worker.send({type:'getright-stop'});await Promise.race([exit,delay(12000)]);await stopProcess(worker);worker=null;};
try{
 worker=launch();await until(async()=>(await get('/api/worker/status')).workers.some(w=>w.connected),'Worker did not register');
 const registration=await api(origin,'/api/worker/presence/connect',{id:'a'.repeat(32),processId:999});
 const bad=await fetch(origin+`/api/worker/presence/${'a'.repeat(32)}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:'0'.repeat(32),kind:'idle',workIds:[],reviewRunIds:[]})});assert.equal(bad.status,400);
 await api(origin,`/api/worker/presence/${'a'.repeat(32)}`,{token:registration.token,kind:'stopped',workIds:[],reviewRunIds:[]});
 assert(!JSON.stringify(await get('/api/worker/status')).includes(registration.token));

 const first=await queue();await review(first.id);const firstFrozen=await frozen(first.id);assert.equal(firstFrozen.run.status,'passed');assert.equal(firstFrozen.run.acceptance,'pending');
 const second=await queue(true);await until(async()=>{const s=await state(second.id);return s.canAdvance&&s.canControl;},'Second test did not start while first review stayed open');
 assert.equal((await state(first.id)).phase,'review');
 browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1700,height:1100}});await page.goto(origin);
 const activity=page.getByRole('region',{name:'Worker activity',exact:true});await expect(activity).toContainText('Waiting for your next step');await expect(activity).toContainText('1 open browser reviews');
 await page.screenshot({path:path.join(dataPath,'review-plus-active-step.png')});
 // Input to the first review is independent of the new test's paused browser.
 await api(origin,`/api/runs/${first.id}/browser/input`,{type:'key',key:'Tab'});await api(origin,`/api/runs/${first.id}/browser/input`,{type:'text',text:'Review-only edit'});
 await activity.getByRole('button',{name:'Finish review',exact:true}).click();await until(async()=>(await state(first.id)).phase==='closed','First review did not close');
 assert.equal((await stored(second.id)).status,'running');assert.equal((await state(second.id)).stepStage,'waiting');assert.deepEqual(await frozen(first.id),firstFrozen);
 await api(origin,`/api/runs/${second.id}/browser/advance`,{stepId:(await state(second.id)).stepId,runRemaining:true});await review(second.id);const secondFrozen=await frozen(second.id);
 report.flows.push({name:'Next test starts with previous review open; paused state visible, input isolated, Finish review affects only its browser and leaves stored evidence unchanged',status:'verified',runIds:[first.id,second.id]});

 const retained=[];for(let i=0;i<3;i++){const run=await queue();await review(run.id);retained.push(run.id);}
 await until(async()=>(await state(second.id)).phase==='closed','Oldest review was not released at the capacity bound');
 assert.equal((await state(second.id)).closedReason,'capacity');assert.deepEqual(await frozen(second.id),secondFrozen);
 for(const id of retained){assert.equal((await state(id)).phase,'review');assert.equal((await stored(id)).acceptance,'pending');}
 await expect(activity).toContainText('Worker available',{timeout:12000});await expect(activity).toContainText('3 open browser reviews');
 const snapshots=await Promise.all(retained.map(frozen));await stop();
 for(let i=0;i<retained.length;i++){await until(async()=>(await state(retained[i])).phase==='closed','Worker stop left a live review');assert.deepEqual(await frozen(retained[i]),snapshots[i]);}
 report.flows.push({name:'Three-review capacity closes oldest with a visible reason; graceful worker stop releases every owned child without changing saved results',status:'verified'});

 // Direct owned session makes an abrupt review-process exit testable without
 // selecting a PID from user input or exposing a browser debugging port.
 sessions=new RunSessions({dashboardUrl:origin,dataPath,headless:true,keepBrowserOpen:true,runTimeoutMs:10000});
 const interrupted=await queue(true),interruptedClaim=await api(origin,'/api/worker/claim',{supportsStepControl:true});
 const interruptedExecution=sessions.execute(interruptedClaim);
 await until(async()=>(await state(interrupted.id)).canAdvance,'Disposable interruption test did not pause');
 await stopProcess(sessions.entries.get(interrupted.id).child);
 assert.equal((await interruptedExecution).status,'interrupted');assert.equal((await stored(interrupted.id)).acceptance,'pending');
 const crashed=await queue(),claim=await api(origin,'/api/worker/claim',{supportsStepControl:true});assert.equal(claim.run.id,crashed.id);
 assert.equal((await sessions.execute(claim)).status,'passed');await review(crashed.id);const crashFrozen=await frozen(crashed.id);
 await stopProcess(sessions.entries.get(crashed.id).child);await until(()=>sessions.entries.size===0,'Exited review child remained registered');assert.deepEqual(await frozen(crashed.id),crashFrozen);
 await sessions.stop();sessions=null;
 // Abrupt parent loss triggers run-child's IPC disconnect handler.
 worker=launch();const orphan=await queue();await review(orphan.id);const orphanFrozen=await frozen(orphan.id);
 const owner=JSON.parse(await readFile(path.join(dataPath,'run-workers',orphan.id,'owner.json'),'utf8'));
 const exit=once(worker,'exit');worker.kill('SIGKILL');await exit;worker=null;
 await until(()=>{try{process.kill(owner.runProcessId,0);return false;}catch{return true;}},'Parent loss left its run process alive',15000);
 await until(async()=>['closed','disconnected'].includes((await state(orphan.id)).phase),'Dead review transport did not expire',35000);assert.deepEqual(await frozen(orphan.id),orphanFrozen);
 report.flows.push({name:'Abrupt review-process and parent loss leave immutable results intact and end browser ownership',status:'verified'});
 console.log(`PASS: independent queue/reviews, visible activity, paused input isolation, review capacity, process ownership and pending acceptance. Evidence: ${dataPath}`);
}finally{await sessions?.stop();await stop();await browser?.close();await dashboard.stop();await writeFile(path.join(dataPath,'independent-reviews-report.json'),JSON.stringify(report,null,2));}
