// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { SessionStore } from "../store.js";
import { installedPlugins } from "./catalog.js";
import { handlePluginRequest } from "./http.js";
import { createServer } from "node:http";
import { VersionStore } from "@sciencediscovery/cas";

async function fixture(t:TestContext) {
  await mkdir(resolve(".tmp"),{recursive:true});
  const root=await mkdtemp(resolve(".tmp/plugin-control-")),store=new SessionStore(root);
  await store.load();
  t.after(async()=>{store.close();await rm(root,{recursive:true,force:true});});
  const project=await store.createProject("Plugins");
  return {store,project,root,control:store.plugins};
}
const signal=()=>new AbortController().signal;
test("project and session overrides persist, retain inheritance and reject undeclared configuration",async t=>{
  const {store,project}=await fixture(t);
  await store.replaceGlobalSettings({plugins:{skill:{enabled:false},scheduler:{config:{policy:"default"}}}});
  await store.replaceProjectSettings(project.id,{plugins:{mcp:{enabled:false}}});
  const session=await store.createSession(project.id,"Child",{plugins:{skill:{enabled:true}}},{},{allowUnconfiguredModel:true});
  const details=store.getSessionSettings(session.id);
  assert.equal(details.effective.plugins?.skill?.enabled,true);
  assert.equal(details.effective.plugins?.mcp?.enabled,false);
  assert.equal(details.inheritedPlugins?.skill?.enabled,false);
  await assert.rejects(store.replaceProjectSettings(project.id,{plugins:{scheduler:{config:{policy:"unknown"}}}}),/Invalid/);
  store.close();await store.load();
  assert.deepEqual(store.getSessionSettings(session.id),details);
});
test("Bridge commands enforce scope, CAS and ownership while subscriptions only invalidate",async t=>{
  const {store,project,control}=await fixture(t),other=await store.createProject("Other");
  const session=await store.createSession(other.id,"Other",{},{},{allowUnconfiguredModel:true});
  assert.throws(()=>control.bridge({projectId:project.id,sessionId:session.id}),/belong/);
  const scope={projectId:project.id},bridge=control.bridge(scope),before=control.snapshot(scope);
  let events=0,otherEvents=0;
  const unsubscribe=control.subscribe(scope,()=>events++);
  control.subscribe({projectId:other.id},()=>otherEvents++);
  const request={apiVersion:1 as const,pluginId:"skill",scope,kind:"command" as const,method:"configure",
    input:{expectedRevision:before.revision,settings:{enabled:false}}};
  await bridge.invoke(request,signal());assert.equal(events,1);assert.equal(otherEvents,0);
  assert.equal(store.getProjectSettings(project.id).effective.plugins?.skill?.enabled,false);
  await assert.rejects(bridge.invoke(request,signal()),/changed/);
  const revision=control.snapshot(scope).revision;
  await assert.rejects(bridge.invoke({...request,input:{expectedRevision:revision,fields:{enabledConnectorIds:[]}}},signal()),/another domain/);
  assert.equal(control.snapshot(scope).revision,revision);
  const read=await bridge.invoke({...request,kind:"query",method:"settings"},signal()) as {settings:{enabled:boolean}};
  assert.equal(read.settings.enabled,false);
  unsubscribe();await store.replaceProjectSettings(project.id,{});assert.equal(events,1);
});
async function compared(t:TestContext) {
  const fixtureResult=await fixture(t),{store,project,control}=fixtureResult;
  const baseline=control.snapshot({projectId:project.id});
  const candidate=await control.create(project.id,baseline.revision,{plugins:{plan:{enabled:false}}});
  const prepared=await control.command(project.id,candidate.id,"prepare",{});
  const experiment=prepared.experiments!;
  const runs=await Promise.all([experiment.baselineSessionId,experiment.candidateSessionId].map(async sessionId=>{
    const run=await store.createSessionRun({sessionId,prompt:"Compare the same task",settingsSnapshot:store.getSessionSettings(sessionId).effective});
    return store.updateSessionRun(sessionId,run.id,{status:"completed"});
  }));
  await control.command(project.id,candidate.id,"compare",{baselineRunId:runs[0]!.id,candidateRunId:runs[1]!.id});
  return {...fixtureResult,candidate,baseline};
}
test("candidate compare, approval and ApplyPort are separate; application is durable and idempotent",async t=>{
  const {store,project,control,candidate,baseline}=await compared(t);
  assert.equal(control.snapshot({projectId:project.id}).revision,baseline.revision);
  await assert.rejects(control.command(project.id,candidate.id,"apply",{}),/transition/);
  await control.command(project.id,candidate.id,"approve",{});
  const applied=await control.command(project.id,candidate.id,"apply",{});
  assert.equal(applied.status,"applied");assert.equal(store.getProjectSettings(project.id).effective.plugins?.plan?.enabled,false);
  assert.deepEqual(await control.command(project.id,candidate.id,"apply",{}),applied);
  store.close();await store.load();
  assert.equal(store.plugins.list(project.id)[0]?.status,"applied");
  assert.equal(store.getProjectSettings(project.id).effective.plugins?.plan?.enabled,false);
});
test("rejection and conflicting active settings never apply a candidate",async t=>{
  const {store,project,control,candidate}=await compared(t);
  await control.command(project.id,candidate.id,"approve",{});
  await store.replaceProjectSettings(project.id,{plugins:{skill:{enabled:false}}});
  const active=control.snapshot({projectId:project.id});
  await assert.rejects(control.command(project.id,candidate.id,"apply",{}),/changed/);
  assert.deepEqual(control.snapshot({projectId:project.id}),active);
  await control.command(project.id,candidate.id,"reject",{});
  await assert.rejects(control.command(project.id,candidate.id,"apply",{}),/transition/);
  assert.deepEqual(control.snapshot({projectId:project.id}),active);
});
test("ApplyPort rolls back settings and receipt when durable receipt fails",async t=>{
  const {store,project,control}=await fixture(t),before=control.snapshot({projectId:project.id});
  await assert.rejects(store.commitPluginSettings(project.id,{plugins:{plan:{enabled:false}}},()=>{},()=>{throw new Error("injected receipt failure");}),/receipt failure/);
  assert.deepEqual(control.snapshot({projectId:project.id}),before);
  store.close();await store.load();
  assert.deepEqual(store.plugins.snapshot({projectId:project.id}),before);
});
test("candidate only replaces allowed names and refuses incomplete or cross-experiment comparison",async t=>{
  const {store,project,control}=await fixture(t),baseline=control.snapshot({projectId:project.id});
  await assert.rejects(control.create(project.id,baseline.revision,{modelId:"other"}),/Only named/);
  const candidate=await control.create(project.id,baseline.revision,{plugins:{plan:{enabled:false}}});
  await control.command(project.id,candidate.id,"prepare",{});
  await assert.rejects(control.command(project.id,candidate.id,"compare",{baselineRunId:"missing",candidateRunId:"missing"}),/completed/);
  assert.equal(store.getProjectSettings(project.id).effective.plugins?.plan,undefined);
  assert.equal(control.describe({projectId:project.id}).status.length,installedPlugins.length);
});
test("candidate CAS records preserve pinned assets and asset drift refuses preparation",async t=>{
  const {project,control,root}=await fixture(t);
  let revision="asset-v1";
  control.bindAssets(async settings=>({settings,assets:{revision}}));
  const before=control.snapshot({projectId:project.id});
  const candidate=await control.create(project.id,before.revision,{plugins:{plan:{enabled:false}}});
  const versions=new VersionStore(root);
  const baseline=await versions.readRecord<{assets:{revision:string}}>(candidate.baselineRef,"PluginComposition");
  const proposed=await versions.readRecord<{assets:{revision:string}}>(candidate.proposedRef,"PluginCandidateComposition");
  assert.equal(baseline.value.assets.revision,"asset-v1");
  assert.equal(proposed.value.assets.revision,"asset-v1");
  revision="asset-v2";
  await assert.rejects(control.command(project.id,candidate.id,"prepare",{}),/assets changed/);
  assert.deepEqual(control.snapshot({projectId:project.id}),before);
  assert.equal(control.list(project.id)[0]?.status,"candidate");
});
test("HTTP Bridge preserves errors and subscriptions release when transport closes",async t=>{
  const {project,control}=await fixture(t);
  const server=createServer((req,res)=>{
    // Authentication remains the outer host boundary, matching the production router.
    if(req.headers.authorization!=="Bearer test"){res.writeHead(401);res.end();return;}
    void handlePluginRequest(req,res,new URL(req.url!,"http://local"),control,async()=>{
      const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));return JSON.parse(Buffer.concat(chunks).toString());
    });
  });
  await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));
  t.after(()=>{server.closeAllConnections();server.close();});
  const address=server.address() as {port:number},url=`http://127.0.0.1:${address.port}/api/projects/${project.id}/plugins`;
  assert.equal((await fetch(url)).status,401);
  const headers={authorization:"Bearer test","content-type":"application/json"};
  const response=await fetch(url+"/bridge",{method:"POST",headers,body:JSON.stringify({apiVersion:1,pluginId:"skill",scope:{projectId:"other"},kind:"query",method:"settings"})});
  assert.equal(response.status,400);assert.equal(typeof (await response.json() as {error:string}).error,"string");
  const abort=new AbortController(),stream=await fetch(url+"/events",{headers,signal:abort.signal});
  const reader=stream.body!.getReader();assert.match(new TextDecoder().decode((await reader.read()).value),/event: changed/);
  abort.abort();await reader.cancel().catch(()=>undefined);
});
