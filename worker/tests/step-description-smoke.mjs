// UI-only long-step snapshots in a disposable DB. No automated pass/acceptance
// is manufactured and no provider, app build or Codex job is executed.
import assert from 'node:assert/strict';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
import {chromium,expect} from '@playwright/test';
import {api,repositoryRoot} from '../src/settings.mjs';
import {dashboardHost} from './dashboard-host.mjs';
const dataPath=path.join(repositoryRoot,'.local',`step-description-${Date.now()}`),dashboard=await dashboardHost(dataPath),origin=dashboard.origin;
const get=route=>api(origin,route),report={scope:'UI-only disposable queued snapshots, full selected-step readability and run-pinned content',flows:[]};
let browser;
try{
 const original=await api(origin,'/api/runs',{testId:'getright-save-note',docked:true});
 const instruction='Select Allow provider drafts, leave Allow sending test emails unchecked, replace the allowed-recipient textarea contents with draft-recipient@example.invalid as its only line, and select the approved-sender checkbox for getright-sender@example.invalid.\nThen inspect the complete saved configuration without enabling an external provider or sending an email.';
 const expected='Draft permission and the approved sender are selected, the textarea contains only draft-recipient@example.invalid, and sending remains unchecked. The complete instruction and this expected result must remain readable in a narrow docked review panel.';
 const snapshot={...original,testSnapshot:{...original.testSnapshot,steps:original.testSnapshot.steps.map((s,i)=>i===1?{...s,title:instruction,expected}:s)}};
 const db=new DatabaseSync(path.join(dataPath,'getright.db'));db.prepare('UPDATE runs SET payload=? WHERE id=?').run(JSON.stringify(snapshot),original.id);db.close();
 const frozen=await get('/api/runs/'+original.id);
 browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1000,height:780}});await page.goto(origin+`/runs/${original.id}`);
 await page.getByRole('link',{name:'Watch test / continue review',exact:true}).click();
 await expect(page).toHaveURL(origin+`/runs/${original.id}/watch`);
 const focused=page.getByRole('region',{name:'Human acceptance',exact:true}),focusedSelect=focused.getByLabel('Test step',{exact:true});
 await expect(focusedSelect).toBeEnabled();
 await focusedSelect.selectOption('edit');
 const focusedDescription=focused.getByRole('region',{name:'Selected test step',exact:true});
 await expect(focusedDescription.locator('.selected-step-instruction')).toHaveText(instruction);
 await expect(focusedDescription.locator('.selected-step-expected')).toHaveText(expected);
 assert(await focusedDescription.evaluate(element=>element.scrollWidth<=element.clientWidth));
 await focusedDescription.scrollIntoViewIfNeeded();await page.screenshot({path:path.join(dataPath,'full-step-narrow-review.png')});
 await page.getByRole('link',{name:/Back to test control room/}).click();
 const panel=page.getByRole('region',{name:'Quick run review',exact:true}),select=panel.getByLabel('Test step',{exact:true});
 await expect(select).toBeEnabled();await expect(panel.getByRole('button',{name:'Accept this run',exact:true})).toBeDisabled();
 await select.selectOption('edit');const description=panel.getByRole('region',{name:'Selected test step',exact:true});
 await expect(description).toHaveAttribute('data-step-id','edit');await expect(description.locator('.selected-step-instruction')).toHaveText(instruction);await expect(description.locator('.selected-step-expected')).toHaveText(expected);
 assert(await description.evaluate(element=>element.scrollWidth<=element.clientWidth));
 await select.selectOption('save');await expect(description.locator('.selected-step-instruction')).toHaveText(snapshot.testSnapshot.steps[2].title);
 const newerId=randomUUID().replaceAll('-',''),newer={...snapshot,id:newerId,fixtureId:`uat-${newerId}`,testSnapshot:{...snapshot.testSnapshot,steps:snapshot.testSnapshot.steps.map((s,i)=>i===1?{...s,title:'A different frozen instruction from the newer run.',expected:'New run expectation.'}:s)}};
 const db2=new DatabaseSync(path.join(dataPath,'getright.db'));db2.prepare('INSERT INTO runs(id,payload) VALUES(?,?)').run(newerId,JSON.stringify(newer));db2.close();
 await expect(panel).toContainText(`A newer run (${newerId.slice(0,8)})`);await select.selectOption('edit');await expect(description.locator('.selected-step-instruction')).toHaveText(instruction);
 assert.equal(await description.getAttribute('data-run-id'),original.id);
 await panel.getByRole('button',{name:'Review latest run',exact:true}).click();await select.selectOption('edit');await expect(description.locator('.selected-step-instruction')).toHaveText(newer.testSnapshot.steps[1].title);
 await page.goto(origin+`/runs/${original.id}`);const full=page.getByRole('region',{name:'Your review',exact:true});await full.getByLabel('Test step',{exact:true}).selectOption('edit');
 await expect(full.getByRole('region',{name:'Selected test step',exact:true}).locator('.selected-step-instruction')).toHaveText(instruction);
 await expect(full.getByLabel('What needs improving?',{exact:true})).toBeDisabled();
 await page.setViewportSize({width:390,height:844});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await full.getByRole('region',{name:'Selected test step',exact:true}).scrollIntoViewIfNeeded();await page.screenshot({path:path.join(dataPath,'full-step-mobile.png')});
 // Old server markup receives the same card from its frozen run, not from the
 // latest catalogue or another run, without a dashboard/browser restart.
 const legacy=await browser.newPage({viewport:{width:340,height:780}});
 await legacy.route('**/legacy-review',route=>route.fulfill({contentType:'text/html',body:`<!doctype html><link rel="stylesheet" href="/app.css"><section class="quick-review"><p class="quick-run-identity"><a href="/runs/${original.id}">Original run</a></p><label for="quick-step">Test step</label><select id="quick-step" disabled>${snapshot.testSnapshot.steps.map(s=>`<option value="${s.id}">${s.title}</option>`).join('')}</select><button id="switch" onclick="document.querySelector('.quick-run-identity a').setAttribute('href','/runs/${newerId}')">Show newer run</button></section><script type="module">import{installReviewStepDescriptions}from'/review-step-description.js';installReviewStepDescriptions();</script>`}));
 await legacy.goto(origin+'/legacy-review');const legacySelect=legacy.getByLabel('Test step',{exact:true});await expect(legacySelect).toBeEnabled();await legacySelect.selectOption('edit');
 const legacyCard=legacy.getByRole('region',{name:'Selected test step',exact:true});await expect(legacyCard.locator('.selected-step-instruction')).toHaveText(instruction);await expect(legacyCard.locator('.selected-step-expected')).toHaveText(expected);
 await legacy.getByRole('button',{name:'Show newer run',exact:true}).click();await expect(legacyCard).toHaveAttribute('data-run-id',newerId);await expect(legacyCard.locator('.selected-step-instruction')).toHaveText(newer.testSnapshot.steps[1].title);
 assert.deepEqual(await get('/api/runs/'+original.id),frozen);assert.equal((await get('/api/runs/'+newerId)).acceptance,'pending');
 report.flows.push({name:'Full wrapping title and expectation, selectable during execution, narrow/mobile layout, pinned run switching and legacy markup compatibility without result mutations',status:'verified'});
 console.log(`PASS: full selected-step descriptions, immutable run attribution, active-run browsing, mobile and legacy UI. Evidence: ${dataPath}`);
}finally{await browser?.close();await dashboard.stop();await writeFile(path.join(dataPath,'step-description-report.json'),JSON.stringify(report,null,2));}
