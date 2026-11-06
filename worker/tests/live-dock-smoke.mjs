// Actual Playwright worker browser streamed through the real local dashboard.
// Disposable demo data only; no Codex or target-application changes.
import assert from 'node:assert/strict';
import path from 'node:path';
import {readFile,writeFile} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {chromium,expect} from '@playwright/test';
import {api,repositoryRoot} from '../src/settings.mjs';
import {dashboardHost} from './dashboard-host.mjs';
import { executeRun, workerClaim } from '../src/run-execution.mjs';

const dataPath=path.join(repositoryRoot,'.local',`live-dock-${Date.now()}`),dashboard=await dashboardHost(dataPath),origin=dashboard.origin;
const report={scope:'Real docked worker pixels/input/session lifetime and immutable run evidence; disposable demo',flows:[],issues:[]};
let browser,workerBrowser,execution;
const reject=async(route,body,status=400)=>{const r=await fetch(origin+route,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});assert.equal(r.status,status,await r.text());};
try{
 browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1600,height:1100}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(origin);const demo=(await api(origin,'/api/catalog')).tests.find(t=>t.id==='getright-save-note');
 await page.locator('.test-card').filter({has:page.getByRole('button',{name:demo.title,exact:true})}).getByRole('button',{name:/^Run UAT test/}).click();
 const panel=page.getByRole('complementary',{name:'Tested application',exact:true});await expect(panel).toBeVisible();
 const viewer=panel.getByRole('region',{name:'Live test browser',exact:true});await expect(viewer).toHaveAttribute('data-phase','waiting');
 const options=viewer.locator('[data-live-options]');await expect(options).not.toHaveAttribute('open','');
 await expect(viewer).not.toContainText('Live session');await expect(viewer).not.toContainText('Interact with the app while paused');
 await expect(viewer.getByRole('button',{name:'Back',exact:true})).toBeHidden();
 await expect(viewer.getByLabel('Text for the selected app field',{exact:true})).toHaveCount(0);
 // Reproduce the user's short desktop viewport: collapsed chrome should leave
 // at least three quarters of the dock's height for the actual application.
 for(const [width,height] of [[1678,620],[2739,821],[390,844]]){
  await page.setViewportSize({width,height});
  const dock=await panel.boundingBox(),screen=await viewer.locator('.live-browser-scroll').boundingBox();
  assert(screen.height/dock.height>=(width<700?0.65:0.75),`The app needs more vertical room at ${width}x${height}: ${screen.height}/${dock.height}`);
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 }
 const details=page.getByRole('region',{name:'Test case in this run',exact:true});
 const acceptance=page.getByRole('region',{name:'Human acceptance',exact:true});
 await expect(page.locator('.catalogue, .worker-activity, .suite-toolbar')).toHaveCount(0);
 await expect(details.getByRole('heading',{name:demo.title,exact:true})).toBeVisible();
 await expect(acceptance.getByRole('button',{name:'Accept this run',exact:true})).toBeDisabled();
 await page.setViewportSize({width:390,height:844});
 assert((await details.boundingBox()).y >= (await panel.boundingBox()).height);
 await page.setViewportSize({width:1600,height:1100});
 assert((await details.boundingBox()).x >= (await panel.boundingBox()).width);
 const [queued]=await api(origin,'/api/runs');assert.equal(queued.docked,true);
 await expect(page).toHaveURL(`${origin}/runs/${queued.id}/watch`);
 const claim=await api(origin,'/api/worker/claim',workerClaim);let reviewPage,ready;
 const reviewReady=new Promise(resolve=>ready=resolve);
 execution=executeRun(claim,{dashboardUrl:origin,dataPath,headless:true,onReviewReady:({browser,run})=>{workerBrowser=browser;reviewPage=browser.contexts()[0].pages()[0];ready(run);}});
 await expect(viewer).toHaveAttribute('data-phase','automating',{timeout:15000});
 await expect(viewer.locator('img')).toBeVisible();
 await expect(viewer.locator('[data-action=finish]')).toBeDisabled();
 await reject(`/api/runs/${queued.id}/browser/input`,{type:'text',text:'Must not interfere with automation'});
 const status=await api(origin,`/api/runs/${queued.id}/browser`);assert(!JSON.stringify(status).includes('token'));assert.equal(status.canControl,false);
 await reject(`/api/runs/${queued.id}/browser/poll`,{token:'0'.repeat(32)});
 const image=await fetch(`${origin}/api/runs/${queued.id}/browser/frame`);assert.equal(image.status,200);assert.equal(image.headers.get('Content-Type'),'image/jpeg');assert.equal(image.headers.get('Cache-Control'),'no-store');
 const bytes=new Uint8Array(await image.arrayBuffer());assert.equal(bytes[0],255);assert.equal(bytes[1],216);
 await page.screenshot({path:path.join(dataPath,'watching-automation.png')});
 const completed=await reviewReady;await expect(viewer).toHaveAttribute('data-phase','review',{timeout:15000});
 assert.equal(completed.status,'passed',completed.error);assert.equal(completed.acceptance,'pending');
 await expect(acceptance.getByRole('button',{name:'Accept this run',exact:true})).toBeEnabled();
 const frozen=await api(origin,`/api/runs/${queued.id}`),trace=await readFile(path.join(dataPath,'evidence',frozen.trace));
 await page.setViewportSize({width:1678,height:620});await page.screenshot({path:path.join(dataPath,'compact-dock-short-desktop.png')});await page.setViewportSize({width:1600,height:1100});
 // Older live servers keep their Razor markup until restart. The new client
 // upgrades that markup without reconnecting or replacing the worker browser.
 const legacy=await browser.newPage({viewport:{width:827,height:620}});
 await legacy.route('**/legacy-live-viewer',route=>route.fulfill({contentType:'text/html',body:`<!doctype html><html><head><link rel="stylesheet" href="/app.css"></head><body><div class="live-run-window"><section id="legacy" class="live-run-viewer" aria-label="Live test browser">
 <div class="live-browser-controls"><button data-command="back">Back</button><button data-command="forward">Forward</button><button data-command="reload">Reload</button><button data-action="zoom">Actual size</button><button data-action="finish">Finish review</button><a href="/runs/${queued.id}">Run details &amp; feedback</a></div>
 <p class="test-page-note" data-live-status role="status"></p><div class="live-step-controls" data-step-controls hidden><p data-step-status role="status"></p><div><button data-action="next-step">Run next step</button><button data-action="remaining-steps">Run remaining steps</button><button data-action="cancel-run">Cancel test</button></div><small>Pause guidance</small></div>
 <a class="test-page-note" data-earlier-review hidden>Earlier review</a><p class="test-page-note">Detailed session guidance.</p><p class="error-text" data-live-error hidden></p><div class="live-browser-scroll"><div class="live-browser-stage" tabindex="-1"><img alt="Live tested application" hidden></div></div><div class="live-browser-text"><label>Text for the selected app field<input data-live-text></label><button data-action="text">Send text</button></div>
 </section></div><script type="module">import {attach} from '/live-run.js';attach(document.getElementById('legacy'),'${queued.id}');</script></body></html>`}));
 await legacy.goto(origin+'/legacy-live-viewer');const migrated=legacy.getByRole('region',{name:'Live test browser',exact:true});await expect(migrated).toHaveAttribute('data-phase','review');
 await expect(migrated.locator('[data-live-summary]')).toContainText('Review ready');await expect(migrated.getByRole('button',{name:'Back',exact:true})).toBeHidden();
 await expect(migrated.getByRole('button',{name:'Finish review',exact:true})).toBeHidden();
 await expect(migrated.locator('.live-browser-text')).toHaveCount(0);
 await expect(migrated).not.toContainText('Detailed session guidance.');await expect(migrated).not.toContainText('Pause guidance');
 assert((await migrated.locator('.live-browser-scroll').boundingBox()).height>500,'Legacy upgrade should preserve most of the application height.');
 await legacy.screenshot({path:path.join(dataPath,'compact-legacy-viewer.png')});await legacy.close();
 assert.equal(workerBrowser.contexts()[0].pages().length,1);
 await reject(`/api/runs/${queued.id}/browser/input`,{type:'evaluate',text:'alert(1)'});
 await reject(`/api/runs/${queued.id}/browser/input`,{type:'click',x:2,y:0});
 const foreign=await fetch(`${origin}/api/runs/${queued.id}/browser/input`,{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://example.invalid'},body:JSON.stringify({type:'text',text:'foreign'})});assert.equal(foreign.status,403);
 // Click the streamed image using coordinates of the actual worker field;
 // type through the dashboard, then assert the same worker session changed.
 const target=await reviewPage.locator('#title').boundingBox(),screen=await viewer.locator('img').boundingBox();
 await viewer.locator('img').click({position:{x:(target.x+target.width/2)/1440*screen.width,y:(target.y+target.height/2)/1000*screen.height}});
 await expect(reviewPage.locator('#title')).toBeFocused({timeout:10000});
 await page.keyboard.press('Control+A');
 await page.keyboard.type('Manual review');
 await expect(reviewPage.locator('#title')).toHaveValue('Manual review',{timeout:10000});
 await options.locator('summary').click();
 await expect(options).toHaveAttribute('open','');await delay(350);await expect(options).toHaveAttribute('open','');
 await expect(viewer.getByRole('button',{name:'Send text',exact:true})).toHaveCount(0);
 await page.screenshot({path:path.join(dataPath,'manual-review-docked.png')});
 await options.locator('summary').click();await expect(viewer.getByLabel('Text for the selected app field',{exact:true})).toBeHidden();
 const popupPromise=page.waitForEvent('popup');await panel.getByRole('link',{name:'Undock ↗',exact:true}).click();const popup=await popupPromise;
 await expect(panel).toHaveCount(0);const undocked=popup.getByRole('region',{name:'Live test browser',exact:true});await expect(undocked).toHaveAttribute('data-phase','review');
 assert.equal(workerBrowser.contexts()[0].pages().length,1,'Undocking must not create a different app session.');
 await expect(acceptance).toBeVisible();
 await undocked.locator('.live-browser-stage').focus();
 await popup.keyboard.press('End');
 await popup.keyboard.type(' undocked');
 await expect(reviewPage.locator('#title')).toHaveValue('Manual review undocked',{timeout:10000});
 await popup.reload();await expect(popup.getByRole('region',{name:'Live test browser',exact:true})).toHaveAttribute('data-phase','review');
 await popup.locator('[data-live-options] > summary').click();
 assert.deepEqual(await api(origin,`/api/runs/${queued.id}`),frozen);assert.deepEqual(await readFile(path.join(dataPath,'evidence',frozen.trace)),trace);
 await popup.getByRole('button',{name:'Finish review',exact:true}).click();assert.equal((await execution).status,'passed');execution=null;assert(!workerBrowser.isConnected());
 await expect(popup.getByRole('region',{name:'Live test browser',exact:true})).toHaveAttribute('data-phase','closed');
 await reject(`/api/runs/${queued.id}/browser/input`,{type:'text',text:'Cannot change a closed session'});
 await page.goto(`${origin}/runs/${queued.id}`);await page.getByRole('link',{name:'Watch test / continue review',exact:true}).click();
 await expect(page.getByRole('region',{name:'Live test browser',exact:true})).toHaveAttribute('data-phase','closed');
 await page.setViewportSize({width:390,height:844});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:path.join(dataPath,'review-mobile.png')});
 assert.deepEqual(errors,[]);assert.deepEqual(await api(origin,`/api/runs/${queued.id}`),frozen);
 await acceptance.getByRole('button',{name:'Accept this run',exact:true}).click();
 await expect(acceptance.getByRole('status')).toContainText('Review saved: Accepted');
 const reviewed=await api(origin,`/api/runs/${queued.id}`);
 assert.equal(reviewed.acceptance,'accepted');
 assert.equal(reviewed.status,frozen.status);
 assert.deepEqual(reviewed.steps,frozen.steps);
 assert.deepEqual(await readFile(path.join(dataPath,'evidence',frozen.trace)),trace);
 report.flows.push({id:'DOCK-001',name:'Automatic docking, real frames, input locked during automation, manual same-session input, undock/reload, finish/reopen, immutable evidence/pending acceptance and mobile',status:'verified',runId:queued.id});

 const auto=await api(origin,'/api/runs',{testId:'getright-save-note',docked:true});const autoResult=await executeRun(await api(origin,'/api/worker/claim',workerClaim),{dashboardUrl:origin,dataPath,headless:true,keepBrowserOpen:false});assert.equal(autoResult.status,'passed');assert.equal((await api(origin,`/api/runs/${auto.id}/browser`)).phase,'closed');
 const stopped=await api(origin,'/api/runs',{testId:'getright-save-note',docked:true}),controller=new AbortController();
 const stoppedResult=await executeRun(await api(origin,'/api/worker/claim',workerClaim),{dashboardUrl:origin,dataPath,headless:true,signal:controller.signal,onReviewReady:()=>controller.abort(new Error('Disposable worker shutdown.'))});assert.equal(stoppedResult.status,'passed');assert.equal(stoppedResult.acceptance,'pending');assert.equal((await api(origin,`/api/runs/${stopped.id}/browser`)).phase,'closed');
 const timeout=await api(origin,'/api/runs',{testId:'getright-save-note',docked:true});const timed=await executeRun(await api(origin,'/api/worker/claim',workerClaim),{dashboardUrl:origin,dataPath,headless:true,runTimeoutMs:1000});assert.equal(timed.status,'failed');assert.equal((await api(origin,`/api/runs/${timeout.id}/browser`)).phase,'closed');
 report.flows.push({id:'DOCK-002',name:'Explicit auto-close, worker shutdown and automation timeout close owned sessions while retaining independent results',status:'verified'});
 console.log(`PASS: actual docked automation/manual review, same-session undock, protected input, immutable evidence, closure and mobile. Evidence: ${dataPath}`);
}finally{await workerBrowser?.close().catch(()=>{});await execution?.catch(()=>{});await browser?.close();await dashboard.stop();await writeFile(path.join(dataPath,'live-dock-report.json'),JSON.stringify(report,null,2));}
