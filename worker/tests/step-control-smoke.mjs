// Real dashboard/worker browser with disposable demo data. No paid providers.
import assert from 'node:assert/strict';
import path from 'node:path';
import {access,writeFile} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {chromium,expect} from '@playwright/test';
import {api,repositoryRoot} from '../src/settings.mjs';
import {dashboardHost} from './dashboard-host.mjs';
import {executeRun} from '../src/runner.mjs';

const dataPath=path.join(repositoryRoot,'.local',`step-control-${Date.now()}`),dashboard=await dashboardHost(dataPath),origin=dashboard.origin;
const get=route=>api(origin,route),claim=()=>api(origin,'/api/worker/claim',{supportsStepControl:true});
const queue=()=>api(origin,'/api/runs',{testId:'getright-save-note',docked:true,stepByStep:true});
const reject=async(route,body)=>{const r=await fetch(origin+route,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});assert.equal(r.status,400,await r.text());};
const report={scope:'Step-by-step/automatic execution, same session and immutable evidence; disposable demo only',flows:[]};
let browser,execution,owned,controller,workerBrowser;
try{
 browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1600,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 const launch=chromium.launch.bind(chromium);
 chromium.launch=async options=>{workerBrowser=await launch(options);return workerBrowser;};
 const demo=(await get('/api/catalog')).tests.find(t=>t.id==='getright-save-note');
 await reject('/api/runs',{testId:demo.id,stepByStep:true});
 const suites = await get('/api/suites');
 const demoSuite = suites.find(suite => suite.testIds.includes(demo.id));
 const otherSuite = suites.find(suite => suite.applicationId !== demoSuite.applicationId);
 const suiteChoice = page.getByLabel('Test suite', {exact:true});
 const modeChoice = page.getByLabel('Execution mode', {exact:true});
 await page.goto(origin);
 await expect(modeChoice).toBeEnabled();
 await expect(modeChoice).toHaveValue('automatic');
 await suiteChoice.selectOption(demoSuite.id);
 await modeChoice.selectOption('step');
 await expect(page.getByRole('button', {name:/^Start step-by-step test/})).toBeEnabled();

 await dashboard.stop();
 await dashboard.start();
 await page.goto(`${origin}/?suite=${otherSuite.id}&view=generation`);
 await expect(suiteChoice).toBeEnabled();
 await expect(suiteChoice).toHaveValue(otherSuite.id);
 await page.goto(origin);
 await expect(suiteChoice).toHaveValue(demoSuite.id);
 await expect(modeChoice).toHaveValue('step');
 const card=page.locator('.test-card').filter({has:page.getByRole('button',{name:demo.title,exact:true})});
 await card.getByRole('button',{name:/^Start step-by-step test/}).click();
 const viewer=page.getByRole('region',{name:'Live test browser',exact:true});await expect(viewer).toBeVisible();
 const [run]=await get('/api/runs');assert.equal(run.stepByStep,true);assert.equal(run.docked,true);
 assert.equal(await api(origin,'/api/worker/claim',{}),null,'Older workers cannot silently run stepped tests automatically.');
 let ready;const reviewing=new Promise(resolve=>ready=resolve);controller=new AbortController();
 execution=executeRun(await claim(),{dashboardUrl:origin,dataPath,headless:true,runTimeoutMs:6000,signal:controller.signal,
  onReviewReady:({browser,run})=>{owned=browser;ready(run);}});
 const acceptance=page.getByRole('region',{name:'Human acceptance',exact:true});
 for(let index=0;index<demo.steps.length;index++){
  const step=demo.steps[index];
  const finalStep=index===demo.steps.length-1;
  const advance=viewer.getByRole('button',{name:finalStep?'Run final step':'Run next step',exact:true});
  await expect(viewer).toHaveAttribute('data-step-id',step.id,{timeout:15000});await expect(viewer).toHaveAttribute('data-step-stage','waiting');
  await expect(advance).toBeEnabled();
  await expect(viewer.locator('[data-action=finish]')).toBeDisabled();
  if(finalStep){
   await expect(acceptance).toContainText(`Automation is paused before step ${demo.steps.length} of ${demo.steps.length}`);
   await expect(acceptance).toContainText('Run final step');
   await expect(acceptance.getByRole('button',{name:'Accept this run',exact:true})).toBeDisabled();
  }
  if(index===0){
   await viewer.locator('.live-browser-stage').focus();await viewer.locator('.live-browser-stage').press('Shift+Escape');
   await expect(viewer.locator('[data-live-options] > summary')).toBeFocused();
   await expect(viewer.locator('[data-live-options]')).not.toHaveAttribute('open','');
   await expect(viewer.locator('[data-live-summary]')).toContainText('Paused before step 1/4');
  }
  await expect(viewer.locator('.live-browser-stage')).toHaveAttribute('tabindex','0');
  await reject(`/api/runs/${run.id}/browser/input`,{type:'text',text:'Stale input',stepId:'not-a-frozen-step'});
  await reject(`/api/runs/${run.id}/browser/advance`,{stepId:'not-a-frozen-step'});
  await reject(`/api/runs/${run.id}/browser/step`,{token:'0'.repeat(32),stepId:step.id,stage:'waiting'});
  await delay(index===0?6500:300); // Human waiting does not spend the 6-second active execution budget.
  assert.equal((await get(`/api/runs/${run.id}`)).status,'running');
  for(let pending=index;pending<demo.steps.length;pending++)
   await assert.rejects(access(path.join(dataPath,'evidence',run.id,`${demo.steps[pending].id}.png`)),'Unreleased steps must not execute or capture passing evidence.');
  if(index===1){
   const app=workerBrowser.contexts()[0].pages()[0];
   const title=app.getByLabel('Title',{exact:true}),box=await title.boundingBox();
   const image=viewer.getByAltText('Live tested application');await expect(image).toBeVisible();
   const rendered=await image.boundingBox();
   await image.click({position:{x:(box.x+box.width/2)/1440*rendered.width,y:(box.y+box.height/2)/1000*rendered.height}});
   await page.keyboard.type('Human input');
   await expect(title).toHaveValue('Human input');
   assert.deepEqual((await get(`/api/runs/${run.id}`)).assistedSteps,[step.id]);
   await expect(viewer.locator('[data-live-status]')).toContainText('Paused');
   await page.goto(`${origin}/runs/${run.id}`);
   await expect(page.locator('.evidence-step').nth(0).locator('.badge')).toHaveText('Passed');
   await expect(page.locator('.evidence-step').nth(1).locator('.badge')).toHaveText('Paused');
   await page.getByRole('link',{name:'Watch test / continue review',exact:true}).click();
   await expect(viewer).toHaveAttribute('data-step-id',step.id);await expect(viewer.getByRole('button',{name:'Run next step',exact:true})).toBeEnabled();
   await expect(page.locator('#active-step-description')).toHaveAttribute('data-step-id',step.id);
   await page.screenshot({path:path.join(dataPath,'paused-after-first-step.png')});
   // Duplicate requests can release this step only, never its successor.
   const releases=await Promise.allSettled([api(origin,`/api/runs/${run.id}/browser/advance`,{stepId:step.id}),api(origin,`/api/runs/${run.id}/browser/advance`,{stepId:step.id})]);
   assert(releases.some(r=>r.status==='fulfilled'));for(const r of releases)if(r.status==='rejected')assert.match(r.reason.message,/displayed step changed/);
  }else await advance.click();
 }
 const completed=await reviewing;assert.equal(completed.status,'passed',completed.error);assert.equal(completed.acceptance,'pending');
 assert.deepEqual(completed.assistedSteps,[demo.steps[1].id]);
 assert.deepEqual(completed.steps.map(s=>s.stepId),demo.steps.map(s=>s.id));assert(completed.steps.every(s=>s.status==='passed'));
 await expect(viewer).toHaveAttribute('data-phase','review');const frozen=await get(`/api/runs/${run.id}`);
 await expect(acceptance.getByRole('button',{name:'Accept this run',exact:true})).toBeEnabled();
 await expect(acceptance.getByRole('button',{name:'Request improvements',exact:true})).toBeEnabled();
 await expect(acceptance.getByRole('button',{name:'Reset to pending',exact:true})).toBeDisabled();
 await expect(viewer.locator('[data-action=next-step]')).toBeHidden();
 await reject(`/api/runs/${run.id}/browser/input`,{type:'text',text:'Late paused input',stepId:demo.steps[1].id});
 await reject(`/api/runs/${run.id}/browser/advance`,{stepId:demo.steps.at(-1).id});
 await page.setViewportSize({width:390,height:844});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:path.join(dataPath,'step-controls-mobile.png')});
 await viewer.locator('[data-live-options] > summary').click();await viewer.getByRole('button',{name:'Finish review',exact:true}).click();await execution;execution=null;
 assert.deepEqual(await get(`/api/runs/${run.id}`),frozen);
 await page.setViewportSize({width:1600,height:1000});await page.goto(`${origin}/runs/${run.id}`);
 await expect(page.getByLabel('Execution mode for next run',{exact:true})).toHaveValue('step');
 await page.getByLabel('Execution mode for next run',{exact:true}).selectOption('automatic');await page.getByRole('button',{name:'Run again',exact:true}).click();
 await expect(page).not.toHaveURL(`${origin}/runs/${run.id}`);
 const [automatic]=await get('/api/runs');assert.equal(automatic.stepByStep,false);
 const auto=await executeRun(await api(origin,'/api/worker/claim',{}),{dashboardUrl:origin,dataPath,headless:true,keepBrowserOpen:false});assert.equal(auto.status,'passed',auto.error);assert.equal(auto.acceptance,'pending');
 assert(!auto.assistedSteps?.length);
 report.flows.push({name:'One step per release, duplicate/stale request protection, reconnect, pause budget, full evidence, pending acceptance, mobile and automatic rerun',runId:run.id,status:'verified'});

 const remaining=await queue();controller=new AbortController();execution=executeRun(await claim(),{dashboardUrl:origin,dataPath,headless:true,keepBrowserOpen:false,signal:controller.signal});
 await page.goto(`${origin}/runs/${remaining.id}/live`);await expect(viewer).toHaveAttribute('data-step-stage','waiting',{timeout:15000});
 await viewer.locator('[data-live-options] > summary').click();
 await viewer.getByRole('button',{name:'Run remaining steps',exact:true}).click();assert.equal((await execution).status,'passed');execution=null;
 report.flows.push({name:'Continue all remaining steps in the same browser',runId:remaining.id,status:'verified'});

 const cancelled=await queue();controller=new AbortController();execution=executeRun(await claim(),{dashboardUrl:origin,dataPath,headless:true,keepBrowserOpen:false,signal:controller.signal});
 await page.goto(`${origin}/runs/${cancelled.id}/live`);await expect(viewer).toHaveAttribute('data-step-stage','waiting',{timeout:15000});
 await viewer.locator('[data-live-options] > summary').click();
 await viewer.getByRole('button',{name:'Cancel test',exact:true}).click();const cancelResult=await execution;execution=null;assert.equal(cancelResult.status,'cancelled');assert(!cancelResult.steps.some(s=>s.status==='passed'));
 await reject(`/api/runs/${cancelled.id}/browser/advance`,{stepId:demo.steps[0].id});

 const expired=await queue();const pauseFailure=await executeRun(await claim(),{dashboardUrl:origin,dataPath,headless:true,keepBrowserOpen:false,stepPauseTimeoutMs:350});
 assert.equal(pauseFailure.id,expired.id);assert.equal(pauseFailure.status,'failed');assert.match(pauseFailure.error,/paused step exceeded/);assert(!pauseFailure.steps.some(s=>s.status==='passed'));

 const stopped=await queue();controller=new AbortController();execution=executeRun(await claim(),{dashboardUrl:origin,dataPath,headless:true,keepBrowserOpen:false,signal:controller.signal});
 await page.goto(`${origin}/runs/${stopped.id}/live`);await expect(viewer).toHaveAttribute('data-step-stage','waiting',{timeout:15000});controller.abort(new Error('Disposable worker shutdown while paused.'));
 assert.equal((await execution).status,'interrupted');execution=null;
 // A lost step-completion acknowledgement must retain one failed step result,
 // rather than appending both a passed and failed result for the same step.
 const lost=await queue(),originalFetch=globalThis.fetch;controller=new AbortController();
 globalThis.fetch=(url,options)=>String(url).endsWith('/browser/step')&&JSON.parse(options.body).stage==='passed'
  ? Promise.resolve(new Response('{}',{status:503})) : originalFetch(url,options);
 try{
  execution=executeRun(await claim(),{dashboardUrl:origin,dataPath,headless:true,keepBrowserOpen:false,signal:controller.signal});
  await page.goto(`${origin}/runs/${lost.id}/live`);await expect(viewer).toHaveAttribute('data-step-stage','waiting',{timeout:15000});
  await viewer.getByRole('button',{name:'Run next step',exact:true}).click();const failed=await execution;execution=null;
  assert.equal(failed.status,'failed');assert.match(failed.error,/HTTP 503/);assert.equal(failed.steps.length,1);assert.equal(failed.steps[0].status,'failed');
 }finally{globalThis.fetch=originalFetch;controller.abort();await execution?.catch(()=>{});execution=null;}
 report.flows.push({name:'Paused cancellation, bounded waiting and worker shutdown release ownership without passing unfinished steps',status:'verified'});
 // Protocol-level race: pending and in-flight input must drain before advance.
 const barrier=await queue(),barrierClaim=await claim(),route=`/api/runs/${barrier.id}/browser`;
 const {token}=await api(origin,route+'/connect',{lease:barrierClaim.lease,width:1440,height:1000,supportsPausedInput:true});
 await api(origin,route+'/step',{token,stepId:demo.steps[0].id,stage:'waiting'});
 await api(origin,route+'/input',{type:'text',text:'Accepted before advance',stepId:demo.steps[0].id});
 await api(origin,route+'/advance',{stepId:demo.steps[0].id});
 assert.equal((await get(route)).canControl,false);
 await reject(route+'/input',{type:'text',text:'Too late',stepId:demo.steps[0].id});
 assert.equal((await api(origin,route+'/step',{token,stepId:demo.steps[0].id,stage:'waiting'})).execute,false);
 const batch=await api(origin,route+'/poll',{token});assert.equal(batch.commands.length,1);
 assert.deepEqual(await api(origin,route+'/poll',{token}),batch,'Lost poll response can be retried without losing the input batch.');
 assert.equal((await api(origin,route+'/step',{token,stepId:demo.steps[0].id,stage:'waiting'})).execute,false);
 await api(origin,route+'/poll',{token,acknowledgedBatch:batch.inputBatch});
 assert.equal((await api(origin,route+'/step',{token,stepId:demo.steps[0].id,stage:'waiting'})).execute,true);
 await reject(route+'/input',{type:'text',text:'During automation',stepId:demo.steps[0].id});
 await api(origin,route+'/step',{token,stepId:demo.steps[0].id,stage:'passed'});
 await api(origin,route+'/step',{token,stepId:demo.steps[1].id,stage:'waiting'});
 await reject(route+'/input',{type:'text',text:'From earlier tab',stepId:demo.steps[0].id});
 await api(origin,`/api/runs/${barrier.id}/cancel`,{});
 await api(origin,`/api/runs/${barrier.id}/complete`,{lease:barrierClaim.lease,status:'cancelled',steps:[]});
 await api(origin,route+'/end',{token});
 report.flows.push({name:'Paused clicks/text, assisted attribution, exact-step input and acknowledged drain barrier before automation',status:'verified'});
 assert.deepEqual(errors,[]);assert.deepEqual(await get(`/api/runs/${run.id}`),frozen);
 console.log(`PASS: step controls, exact ordering, duplicate protection, pause budget, reconnect, automatic continuation, evidence, cancellation, shutdown and mobile. Evidence: ${dataPath}`);
}finally{
 controller?.abort(new Error('Step smoke cleanup.'));await owned?.close().catch(()=>{});await execution?.catch(()=>{});await browser?.close();await dashboard.stop();await writeFile(path.join(dataPath,'step-control-report.json'),JSON.stringify(report,null,2));
}
