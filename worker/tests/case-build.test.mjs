import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import {mkdtemp,mkdir,writeFile,rm,symlink} from 'node:fs/promises';
import {sealCaseBuild} from '../src/case-build.mjs';

async function fixture(run){
 const root=await mkdtemp(path.join(os.tmpdir(),'getright-build-seal-'));
 try{
  const bin=path.join(root,'bin'),assets=path.join(root,'wwwroot');await mkdir(bin);await mkdir(assets);
  const assembly=path.join(bin,'App.dll'),manifest=path.join(bin,'App.staticwebassets.runtime.json');
  await writeFile(assembly,'Synthetic compiled assembly');await writeFile(path.join(bin,'Dependency.dll'),'Dependency');await writeFile(path.join(assets,'app.js'),'Asset');
  await writeFile(manifest,JSON.stringify({ContentRoots:[assets]}));
  await run({root,bin,assets,build:{assembly,manifest,worktree:root}});
 }finally{await rm(root,{recursive:true,force:true});}
}
test('shared-build seal covers dependencies and source-mapped static assets, including added files',async()=>{
 await fixture(async({build,bin,assets})=>{
  let seal=await sealCaseBuild(build);await seal.verify();assert.equal(seal.entries.length,4);
  await writeFile(path.join(bin,'Dependency.dll'),'Changed dependency');await assert.rejects(seal.verify(),/shared application build or static assets changed/);
  seal=await sealCaseBuild(build);await writeFile(path.join(assets,'app.js'),'Changed asset');await assert.rejects(seal.verify(),/changed/);
  seal=await sealCaseBuild(build);await writeFile(path.join(bin,'NewDependency.dll'),'Added dependency');await assert.rejects(seal.verify(),/changed/);
 });
});
test('shared-build seal refuses redirected artifact trees and honors cancellation',async()=>{
 await fixture(async({build,bin,assets})=>{
  const controller=new AbortController();controller.abort(new Error('Build ownership lost'));await assert.rejects(sealCaseBuild(build,controller.signal),/ownership lost/);
  await symlink(assets,path.join(bin,'redirect'),process.platform==='win32'?'junction':'dir');await assert.rejects(sealCaseBuild(build),/redirected artifact/);
 });
});
