// Real Git, dashboard and browser; unsupported plans must stop before build/host.
import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {chromium,expect} from '@playwright/test';
import {api,repositoryRoot} from '../src/settings.mjs';
import {dashboardHost} from './dashboard-host.mjs';
import {executeCaseImplementation} from '../src/case-implementation.mjs';
import {runCommand} from '../src/processes.mjs';
import {workflowEngineDigest} from '../src/workflow-engine.mjs';

const dataPath=path.join(repositoryRoot,'.local',`case-prerequisite-${Date.now()}`);await mkdir(dataPath,{recursive:true});
const dashboard=await dashboardHost(dataPath),origin=dashboard.origin;
const git=(root,args)=>runCommand('git',['-C',root,...args]);
async function repository(name,file){
 const root=path.join(dataPath,name);await mkdir(root);await git(root,['init','--initial-branch=main']);
 await git(root,['config','user.name','Getright Contract']);await git(root,['config','user.email','uat@example.invalid']);
 await writeFile(path.join(root,file),'Synthetic source-only prerequisite fixture.');await git(root,['add','.']);await git(root,['commit','-m','Synthetic baseline']);
 return {root,commit:(await git(root,['rev-parse','HEAD'])).output.trim()};
}
const platform=await repository('platform','README.md'),application=await repository('application','VirtualCompany.sln');
const configuration={dashboardUrl:origin,dataPath,headless:true,jobOptions:{repositoryPath:application.root,worktreeRoot:path.join(repositoryRoot,'worktrees'),codexTimeoutMs:15000,buildTimeoutMs:15000}};
let buildCalls=0,launchCalls=0,browser;
const adapters={platformRepository:platform.root,build:async()=>{buildCalls++;throw new Error('Synthetic build failure after valid planning.');},launch:async()=>{launchCalls++;throw new Error('Unexpected host launch.');}};
const report={scope:'Source-only prerequisites with synthetic compiler and real Git/browser; no Codex, real builds or providers',flows:[]};
async function seed(title){
 const test={id:'draft-'+randomUUID().replaceAll('-',''),applicationId:'virtual-company',title,purpose:'Check prerequisites before compilation.',readiness:'draft',adapter:null,
 reviewQuestion:'Are missing prerequisites clear?',preconditions:'Requires a synthetic invoice and separate reviewer.',steps:[{id:'step-1',title:'Inspect invoice',expected:'The synthetic invoice is visible.'}]};
 const db=new DatabaseSync(path.join(dataPath,'getright.db'));db.prepare('INSERT INTO draft_test_cases(id,suite_id,payload) VALUES(?,?,?)').run(test.id,'virtual-company-suite',JSON.stringify(test));db.close();
 const page=await browser.newPage();await page.goto(origin+'/?view=generation');await page.getByRole('button',{name:title,exact:true}).click();
 await page.getByRole('button',{name:'Approve and implement test case',exact:true}).click();
 await expect(page.getByRole('region',{name:'Test case implementation',exact:true})).toContainText('Case approved and queued');await page.close();
 return {test,job:(await api(origin,`/api/case-implementations?test=${test.id}`))[0]};
}
const claim=()=>api(origin,'/api/worker/case-implementations/claim',{});
const artifact=async(worktree,test,value)=>{const file=path.join(worktree,'config/implemented-tests',test.id+'.json');await mkdir(path.dirname(file),{recursive:true});await writeFile(file,JSON.stringify(value));};
try{
 await api(origin,'/api/applications/virtual-company/profile',{applicationId:'virtual-company',baseUrl:'http://127.0.0.1:1',expectedBuildVersion:'synthetic',expectedUserId:'synthetic-owner',
 expectedCompanyId:'04040404-0404-0404-0404-040404040404',expectedRole:'owner',isolatedDataConfirmed:true,sourceCommit:application.commit,sourceWasDirty:false});
 browser=await chromium.launch({headless:true});
 const missing=await seed('Missing invoice fixture must avoid builds');
 const missingClaim=await claim();
 const reason='The current fixture has no invoice, role sessions or local intake substitute.';
 const result=await executeCaseImplementation(missingClaim,configuration,{...adapters,implement:async({worktree,prompt,report})=>{
  assert.match(prompt,/source-only prerequisite check/);assert.match(prompt,/no application has been built or launched/);
  assert.equal((await api(origin,`/api/case-implementations/${missing.job.id}`)).status,'planning');
  assert.equal((await api(origin,'/api/operations/active')).caseImplementations,1);
  await report('Required invoice fixture is unavailable.',{threadId:'synthetic-prerequisite'});
  await artifact(worktree,missing.test,{blockedReason:reason});return {threadId:'synthetic-prerequisite'};
 }});
 assert.equal(result.status,'blocked');assert.equal(result.error,'Implementation blocked: '+reason);assert.equal(buildCalls,0);assert.equal(launchCalls,0);
 assert.equal(result.validationRunIds,null);assert.equal(result.resultCommit,null);assert.equal(result.threadId,'synthetic-prerequisite');
 assert.deepEqual(JSON.parse(await readFile(path.join(dataPath,'case-implementations',result.id,'workflow.json'),'utf8')),{blockedReason:reason});
 const events=await api(origin,`/api/case-implementations/${result.id}/events`);assert(events.some(e=>e.stage==='planning'));assert(!events.some(e=>e.stage==='building'));
 const page=await browser.newPage({viewport:{width:1440,height:1000}});await page.goto(origin+'/?view=generation');
 const row=page.getByRole('region',{name:'Test case generation progress',exact:true}).locator('.generation-case').filter({has:page.getByRole('link',{name:missing.test.title,exact:true})});
 await expect(row.locator('.badge')).toHaveText('Prerequisites missing');await expect(row).toContainText(reason);await expect(row.getByRole('button',{name:'Retry case generation',exact:true})).toBeDisabled();
 const readiness=await api(origin,`/api/tests/${missing.test.id}/implementation-readiness`);assert.equal(readiness.allowed,false);assert.equal(readiness.engineDigest,workflowEngineDigest);
 const unchanged=await fetch(`${origin}/api/case-implementations/${result.id}/retry`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({definitionDigest:result.definitionDigest})});assert.equal(unchanged.status,400);assert.match(await unchanged.text(),/unchanged prerequisites/);
 const reapprove=await fetch(`${origin}/api/tests/${missing.test.id}/approve-implementation`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({definitionDigest:result.definitionDigest})});assert.equal(reapprove.status,400);
 await page.getByRole('button',{name:'Virtual Company',exact:true}).click();
 await expect(page.getByRole('region',{name:'Bulk test case approval',exact:true})).toContainText('1 case has unchanged prerequisite blockers');
 await expect(page.getByRole('button',{name:'Approve all pending test cases (0)',exact:true})).toBeDisabled();
 assert.equal((await api(origin,`/api/case-implementations?test=${missing.test.id}`)).length,1);
 await page.screenshot({path:path.join(dataPath,'prerequisite-blocked.png'),fullPage:true});
 // A genuinely changed clean source receipt can be reviewed again. Cosmetic
 // runtime/version changes cannot unblock the same source and fixture.
 const originalProfile=await api(origin,'/api/applications/virtual-company/profile');
 await api(origin,'/api/applications/virtual-company/profile',{...originalProfile,expectedBuildVersion:'cosmetic-version-change'});
 assert.equal((await api(origin,`/api/tests/${missing.test.id}/implementation-readiness`)).allowed,false);
 await writeFile(path.join(application.root,'fixture-v2.txt'),'A synthetic prerequisite capability revision.');await git(application.root,['add','.']);await git(application.root,['commit','-m','Synthetic prerequisite extension']);
 application.commit=(await git(application.root,['rev-parse','HEAD'])).output.trim();
 await api(origin,'/api/applications/virtual-company/profile',{...originalProfile,sourceCommit:application.commit});
 assert.equal((await api(origin,`/api/tests/${missing.test.id}/implementation-readiness`)).allowed,true);
 await page.goto(`${origin}/case-implementations/${result.id}`);await page.getByRole('button',{name:'Retry case generation',exact:true}).click();
 await expect(page).not.toHaveURL(`${origin}/case-implementations/${result.id}`);
 const retryClaim=await claim();assert.equal(retryClaim.job.retryOfJobId,result.id);
 const validPlan={version:1,fixture:'virtual-company-test-company',entryPath:'/settings/test-company?companyId={{companyId}}',reviewPath:'/test-companies/new',steps:[{stepId:'step-1',actions:[{kind:'expect-visible',selector:'.test-policy h2'}]}]};
 const buildFailed=await executeCaseImplementation(retryClaim,configuration,{...adapters,implement:async({worktree,report})=>{
  await report('Synthetic supported plan.',{threadId:'synthetic-valid-plan'});await artifact(worktree,missing.test,validPlan);return {threadId:'synthetic-valid-plan'};
 }});
 assert.equal(buildCalls,1);assert.equal(launchCalls,0);assert.equal(buildFailed.status,'failed');assert.match(buildFailed.error,/Synthetic build failure/);assert(buildFailed.resultCommit);
 const retryEvents=await api(origin,`/api/case-implementations/${buildFailed.id}/events`);assert(retryEvents.findIndex(e=>e.stage==='planning')<retryEvents.findIndex(e=>e.stage==='building'));
 report.flows.push('Missing prerequisites produce retained actionable output without a build or host. Only a bounded validated and committed plan proceeds to build; build failures retain the result commit.');

 const unsafe=await seed('Unsafe plan must avoid builds');
 const invalid={...validPlan,steps:[{stepId:'step-1',actions:[{kind:'evaluate',value:'alert(1)'},{kind:'expect-visible',selector:'body'}]}]};
 const unsafeResult=await executeCaseImplementation(await claim(),configuration,{...adapters,implement:async({worktree})=>{await artifact(worktree,unsafe.test,invalid);return {};}});
 assert.equal(unsafeResult.status,'failed');assert.match(unsafeResult.error,/Unsupported workflow action/);assert.equal(buildCalls,1);
 const cancel=await seed('Cancel during source-only planning');let started;
 const reached=new Promise(resolve=>started=resolve);
 const cancelledExecution=executeCaseImplementation(await claim(),configuration,{...adapters,implement:async({signal})=>{
  started();await new Promise((_,reject)=>{signal.addEventListener('abort',()=>reject(signal.reason),{once:true});});
 }});
 await reached;await page.goto(`${origin}/case-implementations/${cancel.job.id}`);await expect(page.locator('header .badge')).toHaveText('Planning');
 await page.getByRole('button',{name:'Cancel implementation',exact:true}).click();assert.equal((await cancelledExecution).status,'cancelled');assert.equal(buildCalls,1);
 const expired=await seed('Planning lease expiry');const expiredClaim=await claim();
 const metadata={lease:expiredClaim.lease,stage:'planning',message:'Source-only planning recovery contract.',platformBaseCommit:platform.commit,worktreePath:platform.root};
 await api(origin,`/api/case-implementations/${expired.job.id}/report`,metadata);
 const backward=await fetch(`${origin}/api/case-implementations/${expired.job.id}/report`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...metadata,stage:'preparing'})});assert.equal(backward.status,400);
 const db=new DatabaseSync(path.join(dataPath,'getright.db'));db.prepare('UPDATE case_implementation_jobs SET lease_expires=? WHERE id=?').run('2000-01-01T00:00:00+00:00',expired.job.id);db.close();
 assert.equal((await api(origin,`/api/case-implementations/${expired.job.id}`)).status,'interrupted');
 const restarted=await seed('Planning restart recovery');const restartClaim=await claim();await api(origin,`/api/case-implementations/${restarted.job.id}/report`,{...metadata,lease:restartClaim.lease});
 await dashboard.stop();await dashboard.start();assert.equal((await api(origin,`/api/case-implementations/${restarted.job.id}`)).status,'interrupted');
 assert.equal((await api(origin,'/api/operations/active')).caseImplementations,0);assert.equal((await api(origin,'/api/runs')).length,0);
 const legacy=await seed('Legacy blocker hidden behind cancelled retries');const legacyClaim=await claim();
 const legacyFailure=await api(origin,`/api/case-implementations/${legacy.job.id}/finish`,{lease:legacyClaim.lease,status:'failed',error:'Implementation blocked: Legacy invoice fixture is missing.'});
 const legacyRoot=path.join(dataPath,'case-implementations',legacy.job.id);await mkdir(legacyRoot,{recursive:true});await writeFile(path.join(legacyRoot,'summary.json'),JSON.stringify({engineDigest:workflowEngineDigest}));
 const history=new DatabaseSync(path.join(dataPath,'getright.db')),insert=history.prepare('INSERT INTO case_implementation_jobs(id,test_id,payload) VALUES(?,?,?)');
 let latestCancelled;
 for(let index=0;index<110;index++){latestCancelled={...legacyFailure,id:randomUUID().replaceAll('-',''),status:'cancelled',error:'Disposable cancelled retry.'};insert.run(latestCancelled.id,legacy.test.id,JSON.stringify(latestCancelled));}history.close();
 const hiddenBlocker=await api(origin,`/api/tests/${legacy.test.id}/implementation-readiness`);assert.equal(hiddenBlocker.allowed,false);assert.equal(hiddenBlocker.blockedJobId,legacy.job.id);
 const blockedLatest=await fetch(`${origin}/api/case-implementations/${latestCancelled.id}/retry`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({definitionDigest:latestCancelled.definitionDigest})});assert.equal(blockedLatest.status,400);
 // Simulate a different recorded fixture engine on disposable data only; the
 // server must permit review against a genuinely different installed engine.
 const provenance=new DatabaseSync(path.join(dataPath,'getright.db'));provenance.prepare('UPDATE case_implementation_jobs SET payload=? WHERE id=?').run(JSON.stringify({...legacyFailure,engineDigest:'f'.repeat(64)}),legacy.job.id);provenance.close();
 assert.equal((await api(origin,`/api/tests/${legacy.test.id}/implementation-readiness`)).allowed,true);
 const restore=new DatabaseSync(path.join(dataPath,'getright.db'));restore.prepare('UPDATE case_implementation_jobs SET payload=? WHERE id=?').run(JSON.stringify(legacyFailure),legacy.job.id);restore.close();
 await dashboard.stop();await dashboard.start();assert.equal((await api(origin,`/api/tests/${legacy.test.id}/implementation-readiness`)).allowed,false);
 const edited={...legacy.test,purpose:'Reviewed new case definition.'};const changed=new DatabaseSync(path.join(dataPath,'getright.db'));changed.prepare('UPDATE draft_test_cases SET payload=? WHERE id=?').run(JSON.stringify(edited),edited.id);changed.close();
 assert.equal((await api(origin,`/api/tests/${legacy.test.id}/implementation-readiness`)).allowed,true);
 const stale=await fetch(`${origin}/api/case-implementations/${latestCancelled.id}/retry`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({definitionDigest:latestCancelled.definitionDigest})});assert.equal(stale.status,400,'Changed definitions still need fresh explicit review.');
 report.flows.push('Unchanged blockers stop retry/reapproval/bulk before queueing, including legacy summaries and blockers beyond 100 newer cancellations. Cosmetic build-version changes do not bypass; changed source/engine/definition can be reviewed again. Blocker history survives restart.');
 assert.equal((await git(application.root,['status','--porcelain'])).output.trim(),'');assert.equal((await git(platform.root,['status','--porcelain'])).output.trim(),'');
 report.flows.push('Invalid plans never build. Planning remains cancellable, leased, counted as active, monotonic and recoverable after restart; no UAT result or acceptance is manufactured.');
 console.log(`PASS: prerequisite-before-build, blocked/unsafe plans, source attribution, retry, planning cancellation/recovery and browser diagnostics. Evidence: ${dataPath}`);
}finally{await browser?.close();await dashboard.stop();await writeFile(path.join(dataPath,'prerequisite-report.json'),JSON.stringify(report,null,2));}
