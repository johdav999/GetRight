// Opt-in, no-model validation: one actual Virtual Company build shared by two
// existing permission plans, each with a new host and two fresh test companies.
import assert from 'node:assert/strict';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
import {chromium,expect} from '@playwright/test';
import {api,repositoryRoot,settings} from '../src/settings.mjs';
import {executeCaseImplementationBatch} from '../src/case-batch.mjs';
import {buildVirtualCompany,launchVirtualCompany} from '../src/virtual-company-host.mjs';
import {dashboardHost} from './dashboard-host.mjs';

const sourceOrigin=settings().dashboardUrl,profile=await api(sourceOrigin,'/api/applications/virtual-company/profile');
assert(profile&&!profile.sourceWasDirty&&profile.sourceCommit,'Import a clean Virtual Company launch receipt first.');
const catalog=await api(sourceOrigin,'/api/catalog'),originals=catalog.tests.filter(t=>t.applicationId==='virtual-company'&&t.implementation?.applicationSourceCommit===profile.sourceCommit).slice(0,2);
assert.equal(originals.length,2,'This opt-in check needs two retained permission workflows for the configured application source.');
const dataPath=path.join(repositoryRoot,'.local',`case-batch-live-${Date.now()}`),dashboard=await dashboardHost(dataPath),origin=dashboard.origin;
let browser,buildCalls=0,launchCalls=0,liveHosts=0,maxHosts=0,plansPrepared=0;
try{
 await api(origin,'/api/applications/virtual-company/profile',profile);
 browser=await chromium.launch({headless:true});const sourcePlans=new Map();
 for(const original of originals){
  assert.equal(createHash('sha256').update(original.implementation.planJson).digest('hex'),original.implementation.planDigest);
  const test={...original,id:'draft-batch-live-'+randomUUID().replaceAll('-',''),title:'Shared-build proof: '+original.title,readiness:'draft',adapter:null,implementation:null};
  sourcePlans.set(test.id,original.implementation.planJson);
  const db=new DatabaseSync(path.join(dataPath,'getright.db'));db.prepare('INSERT INTO draft_test_cases(id,suite_id,payload) VALUES(?,?,?)').run(test.id,'virtual-company-suite',JSON.stringify(test));db.close();
  const page=await browser.newPage();await page.goto(origin+'/?view=generation');await page.getByRole('button',{name:test.title,exact:true}).click();await page.getByRole('button',{name:'Approve and implement test case',exact:true}).click();await expect(page.getByRole('region',{name:'Test case implementation',exact:true})).toContainText('Case approved and queued');await page.close();
 }
 const batch=await api(origin,'/api/worker/case-implementations/claim-batch',{});assert.equal(batch.claims.length,2);
 const outcomes=await executeCaseImplementationBatch(batch,{...settings(),dashboardUrl:origin,dataPath,headless:true},{
  implement:async({worktree,prompt})=>{
   const id=[...sourcePlans.keys()].find(id=>prompt.includes(`"id": "${id}"`));assert(id);
   const file=path.join(worktree,'config/implemented-tests',id+'.json');await mkdir(path.dirname(file),{recursive:true});await writeFile(file,sourcePlans.get(id));plansPrepared++;
   return {threadId:'synthetic-retained-permission-plan-copy',summary:'Existing permission workflow copied for batch validation; no model invocation.'};
  },
  build:async args=>{assert.equal(plansPrepared,2);buildCalls++;return buildVirtualCompany(args);},
  launch:async args=>{launchCalls++;liveHosts++;maxHosts=Math.max(maxHosts,liveHosts);const host=await launchVirtualCompany(args);let stopped=false;return {...host,stop:async()=>{if(!stopped){stopped=true;try{await host.stop();}finally{liveHosts--;}}}};},
 });
 assert(outcomes.every(j=>j.status==='verified'),outcomes.map(j=>j.error).join('\n'));assert.equal(buildCalls,1);assert.equal(launchCalls,2);assert.equal(maxHosts,1);assert.equal(liveHosts,0);
 assert.equal(new Set(outcomes.map(j=>j.validationTarget.expectedBuildVersion)).size,1);assert.equal(new Set(outcomes.map(j=>j.sharedBuild.artifactDigest)).size,1);assert.equal(new Set(outcomes.map(j=>j.validationTarget.baseUrl)).size,2);
 const proofs=await Promise.all(outcomes.flatMap(j=>j.validationRunIds).map(id=>api(origin,`/api/runs/${id}`)));assert.equal(proofs.length,4);assert(proofs.every(r=>r.status==='passed'&&r.acceptance==='pending'));assert.equal(new Set(proofs.map(r=>r.identity.companyId)).size,4);
 const page=await browser.newPage({viewport:{width:1500,height:1000}});await page.goto(`${origin}/case-implementations/${outcomes[1].id}`);await expect(page.locator('.notice').filter({hasText:'shared application build'})).toBeVisible();await page.screenshot({path:path.join(dataPath,'shared-build-attribution.png'),fullPage:true});await page.close();
 const report={scope:'One actual clean Virtual Company build, two retained permission plans, no new model invocation',batch:batch.id,source:profile.sourceCommit,buildCalls,launchCalls,maxHosts,
  cases:outcomes.map(j=>({id:j.id,status:j.status,sharedBuild:j.sharedBuild,validationTarget:j.validationTarget,proofs:j.validationRunIds})),companies:proofs.map(r=>r.identity.companyId),acceptance:'pending'};
 await writeFile(path.join(dataPath,'case-batch-live-report.json'),JSON.stringify(report,null,2));console.log(`PASS: ONE actual Virtual Company build, TWO sequential fresh hosts, FOUR distinct companies and passing validations; pending human acceptance. Evidence: ${dataPath}`);
}finally{await browser?.close();await dashboard.stop();}
