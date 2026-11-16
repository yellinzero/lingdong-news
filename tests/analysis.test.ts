import {test} from 'node:test';
import assert from 'node:assert/strict';
import {AnalysisQueue,planAnalysis,applyAnalysis,syncAnalysisPending,eligibleForAI,type BatchInput,type BatchJudgement} from '../src/analysis.ts';
import {emptyState,fingerprint,type NewsItem,type Judgement} from '../src/core.ts';
const make=(i:number):NewsItem=>({id:`cls:${i}`,source:'cls',title:'',body:`芯片公司宣布订单增长${i}%，计划推进新一轮产能建设。`,publishedAt:Date.now()-i,url:'',tags:[]});
const judgement=(key:string):Judgement=>({kind:'json',relevant:true,probability:1,model:'mock',reason:'直接相关',tags:[],fingerprint:key,contextFingerprint:key});
const results=(inputs:BatchInput[]):BatchJudgement[]=>[...inputs].reverse().map(i=>({id:i.item.id,judgement:judgement(i.fingerprint)}));
const wait=async(condition:()=>boolean,timeout=1000)=>{const end=Date.now()+timeout;while(!condition()){if(Date.now()>end)throw new Error('queue condition timed out');await new Promise(r=>setTimeout(r,5));}};
test('batch reservations prevent overlap during refresh, with bounded concurrency and complete ID mapping',async()=>{
  const state=emptyState();state.items=Array.from({length:9},(_,i)=>make(i));
  const requests:{inputs:BatchInput[];resolve:(r:BatchJudgement[])=>void}[]=[];let active=0,maxActive=0;
  const queue=new AnalysisQueue({jobs:()=>planAnalysis(state),enabled:()=>true,batchSize:()=>3,concurrency:()=>2,
    dispatch:inputs=>{active++;maxActive=Math.max(maxActive,active);return new Promise(resolve=>requests.push({inputs,resolve:r=>{active--;resolve(r);}}));},
    apply:(key,j)=>{applyAnalysis(state,key,j);},changed:()=>{},error:e=>{throw new Error(e);}});
  queue.schedule(0);queue.schedule(0);await wait(()=>requests.length===2);
  const duplicate={...state.items[0],id:'jin10:duplicate',source:'jin10'};state.items.push(duplicate);queue.schedule(0);await new Promise(r=>setTimeout(r,20));
  assert.equal(requests.length,2);requests[0].resolve(results(requests[0].inputs));await wait(()=>requests.length===3);
  requests[1].resolve(results(requests[1].inputs));requests[2].resolve(results(requests[2].inputs));await wait(()=>!queue.active);
  assert.equal(maxActive,2);const sent=requests.flatMap(r=>r.inputs.map(i=>i.fingerprint));assert.equal(sent.length,9);assert.equal(new Set(sent).size,9);
  assert.ok(state.items.every(i=>i.judgement?.relevant));assert.ok(duplicate.judgement);assert.equal(planAnalysis(state).length,0);
});
test('cross-source exact duplicates reuse persisted results; distinct near-news and numeric changes are judged independently',()=>{
  const state=emptyState();state.items=[make(1)];const job=planAnalysis(state)[0];assert.ok(applyAnalysis(state,job.key,judgement(job.key)));
  const duplicate={...make(1),id:'jin10:other',source:'jin10',judgement:undefined};state.items.push(duplicate);
  assert.equal(planAnalysis(state).length,0);assert.equal(duplicate.judgement?.fingerprint,fingerprint(duplicate,state.preferences));
  state.preferences.ai.batchSize=16;state.preferences.ai.concurrency=4;assert.equal(planAnalysis(state).length,0);
  state.items.push({...make(2),id:'wallstreet:new',source:'wallstreet'});assert.equal(planAnalysis(state).length,1);
  state.items[0]={...make(1),body:'芯片公司宣布订单增长1.5%，计划推进新一轮产能建设。'};assert.equal(planAnalysis(state).length,2);
  state.preferences.ai.systemPrompt+=' 修改规则';assert.equal(planAnalysis(state).length,3);
});
test('late batch response cannot overwrite a corrected item or changed criteria',async()=>{
  const state=emptyState();state.items=[make(1)];const requests:{inputs:BatchInput[];resolve:(r:BatchJudgement[])=>void}[]=[];
  const queue=new AnalysisQueue({jobs:()=>planAnalysis(state),enabled:()=>true,batchSize:()=>8,concurrency:()=>2,dispatch:inputs=>new Promise(resolve=>requests.push({inputs,resolve})),apply:(key,j)=>{applyAnalysis(state,key,j);},changed:()=>{},error:()=>{}});
  queue.schedule(0);await wait(()=>requests.length===1);state.items=[{...make(1),body:'更正：芯片公司宣布订单下降15%，终止新一轮产能建设。'}];queue.schedule(0);await wait(()=>requests.length===2);
  requests[0].resolve(results(requests[0].inputs));await new Promise(r=>setTimeout(r,15));assert.equal(state.items[0].judgement,undefined);
  requests[1].resolve(results(requests[1].inputs));await wait(()=>!queue.active);assert.equal(state.items[0].judgement?.relevant,true);
  state.items[0].judgement=undefined;state.analysisHistory=[];queue.schedule(0);await wait(()=>requests.length===3);state.preferences.interests='改变关注主题';queue.reset();requests[2].resolve(results(requests[2].inputs));await wait(()=>requests.length===4);assert.equal(state.items[0].judgement,undefined);requests[3].resolve(results(requests[3].inputs));await wait(()=>!queue.active);
});
test('missing batch results stay pending, retry is bounded and manual retry recovers them',async()=>{
  const state=emptyState();state.items=[make(1)];let calls=0,errors=0,recover=false;
  const queue=new AnalysisQueue({jobs:()=>planAnalysis(state),enabled:()=>true,batchSize:()=>8,concurrency:()=>1,dispatch:async inputs=>{calls++;return recover?results(inputs):[];},apply:(key,j)=>{applyAnalysis(state,key,j);},changed:()=>{},error:()=>{errors++;}});
  queue.schedule(0);await wait(()=>queue.failed===1,3500);assert.equal(calls,2);assert.equal(errors,2);assert.equal(state.items[0].judgement,undefined);assert.equal(planAnalysis(state).length,1);
  recover=true;queue.retry();await wait(()=>!!state.items[0].judgement);assert.equal(calls,3);assert.equal(queue.failed,0);
});
test('pending analysis survives raw cache eviction and restart without losing matched unread news',()=>{
  let state=emptyState();state.preferences.aiEnabled=true;state.preferences.interests='芯片';state.items=[make(1)];syncAnalysisPending(state);assert.equal(state.analysisPending.length,1);
  state.items=[];state=JSON.parse(JSON.stringify(state));const job=planAnalysis(state)[0];assert.ok(job);applyAnalysis(state,job.key,judgement(job.key));assert.equal(state.analysisPending.length,0);assert.equal(state.unread.length,1);
});

test('multi-source arrivals enter pending analysis before the bounded display cache can evict them',()=>{
  const state=emptyState();state.preferences.aiEnabled=true;state.preferences.interests='芯片';const incoming=Array.from({length:1100},(_,i)=>make(i));
  syncAnalysisPending(state,incoming);assert.equal(state.analysisPending.length,1100);assert.equal(planAnalysis(state).length,1100);
});

test('recency, enable cutoff, estimated dates and corrections bound AI scope without removing news',()=>{
 const state=emptyState(),now=Date.now();state.preferences.aiStartedAt=now-60000;
 const old={...make(1),publishedAt:now-3600000},before={...make(2),publishedAt:now-120000},fresh={...make(3),publishedAt:now-1000};
 assert.equal(eligibleForAI(old,state,now),false);assert.equal(eligibleForAI(before,state,now),false);assert.equal(eligibleForAI(fresh,state,now),true);
 assert.equal(eligibleForAI({...fresh,dateEstimated:true},state,now),false);assert.equal(eligibleForAI({...old,updatedAt:now},state,now),true);
 state.preferences.aiLimits.newOnly=false;assert.equal(eligibleForAI(before,state,now),true);assert.equal(eligibleForAI(old,state,now),false);
 state.items=[old,before,fresh];assert.equal(planAnalysis(state).length,2);assert.equal(state.items.length,3);
});
test('stop during asynchronous planning prevents dispatch; zero retries bounds a failed attempt',async()=>{
 const state=emptyState();state.items=[make(1)];let resolvePlan!:(jobs:ReturnType<typeof planAnalysis>)=>void,calls=0,enabled=true;
 const queue=new AnalysisQueue({jobs:()=>new Promise(resolve=>resolvePlan=resolve),enabled:()=>enabled,maxRetries:()=>0,batchSize:()=>1,concurrency:()=>1,dispatch:async()=>{calls++;throw 'mock failure';},apply:()=>{},changed:()=>{},error:()=>{}});
 queue.schedule(0);await wait(()=>!!resolvePlan);enabled=false;queue.stop();resolvePlan(planAnalysis(state));await wait(()=>!queue.active);assert.equal(calls,0);
 enabled=true;queue.schedule(0);await new Promise(r=>setTimeout(r,10));resolvePlan(planAnalysis(state));await wait(()=>queue.failed===1);assert.equal(calls,1);await new Promise(r=>setTimeout(r,40));assert.equal(calls,1);queue.stop();
});

test('rate waits do not consume retries and fresh news wins when the window reopens',async()=>{
 const state=emptyState();state.items=[make(1),make(2)];const sent:string[]=[];let attempts=0,errors=0;
 const queue=new AnalysisQueue({jobs:()=>planAnalysis(state),enabled:()=>true,maxRetries:()=>0,minIntervalMs:()=>20,batchSize:()=>1,concurrency:()=>2,dispatch:async inputs=>{attempts++;if(attempts===1)throw `AI_WAIT:${Date.now()+100}`;sent.push(inputs[0].item.body);return results(inputs);},apply:(key,j)=>{applyAnalysis(state,key,j);},changed:()=>{},error:()=>errors++});
 queue.schedule(0);await wait(()=>attempts===1);state.items.push({...make(3),body:'刚刚到达的最新消息',publishedAt:Date.now()+1});queue.schedule(0);await wait(()=>sent.length===3);
 assert.match(sent[0],/刚刚到达/);assert.equal(queue.failed,0);assert.equal(errors,0);assert.equal(attempts,4);queue.stop();
});
test('pacing spaces batches continuously rather than stopping after a cumulative count',async()=>{
 const state=emptyState();state.items=Array.from({length:30},(_,i)=>make(i));const times:number[]=[];
 const queue=new AnalysisQueue({jobs:()=>planAnalysis(state),enabled:()=>true,minIntervalMs:()=>8,maxRetries:()=>0,batchSize:()=>1,concurrency:()=>4,dispatch:async inputs=>{times.push(Date.now());return results(inputs);},apply:(key,j)=>{applyAnalysis(state,key,j);},changed:()=>{},error:()=>{}});
 queue.schedule(0);await wait(()=>times.length===30,2000);assert.ok(times.slice(1).every((t,i)=>t-times[i]>=8));assert.equal(planAnalysis(state).length,0);queue.stop();
});
