import {test} from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate} from 'node:timers/promises';
import {AnalysisQueue,planAnalysis,applyAnalysis,mergeAnalysisHistory,type BatchInput} from '../src/analysis.ts';
import {BatchPolicy,requestInterval} from '../src/batch-policy.ts';
import {emptyState,isMatch,type Judgement} from '../src/core.ts';
const story=(n:number)=>({id:`cls:${n}`,source:'cls',title:'',body:`科技公司订单增长 ${n}%，发布新的产品。`,publishedAt:Date.now(),url:'',tags:[]});
const result=(key:string,relevant=true):Judgement=>({kind:'json',relevant,probability:relevant?1:0,reason:'相关判断',model:'mock',fingerprint:key,contextFingerprint:key});

test('positive and negative decisions survive disable, eviction, disk JSON roundtrip and cross-source republication',()=>{
 let state=emptyState();state.preferences.interests='科技';state.items=[story(1),story(2)];
 for(const job of planAnalysis(state))applyAnalysis(state,job.key,result(job.key,job.item.body.includes(' 1%')));
 assert.equal(state.analysisHistory.length,2);state.preferences.aiEnabled=false;state.preferences.aiPaused=true;
 assert.equal(isMatch(state.items[0],state.preferences,false),true);assert.equal(isMatch(state.items[1],state.preferences,false),false);
 state.items=[];state.unread=[];state.readStories=[];state.analysisPending=[];state=JSON.parse(JSON.stringify(state));
 state.preferences.aiStartedAt=Date.now()+1;state.items=[story(1),story(2)].map(item=>({...item,id:`jin10:copy-${item.id}`,source:'jin10'}));
 assert.equal(planAnalysis(state).length,0);assert.equal(isMatch(state.items[0],state.preferences,false),true);assert.equal(state.items[1].judgement?.relevant,false);
 state.preferences.aiEnabled=true;state.preferences.aiLimits.newOnly=false;assert.equal(planAnalysis(state).length,0);
});
test('cached decisions are reused only for unchanged content and criteria, including returning to a previous profile',()=>{
 const state=emptyState();state.preferences.interests='科技';state.items=[story(1)];const job=planAnalysis(state)[0];applyAnalysis(state,job.key,result(job.key));
 state.items=[story(3)];assert.equal(planAnalysis(state).length,1);state.items=[story(1)];state.preferences.interests='体育';assert.equal(planAnalysis(state).length,1);
 state.preferences.interests='科技';assert.equal(planAnalysis(state).length,0);assert.equal(isMatch(state.items[0],state.preferences,false),true);
});
test('legacy item decisions migrate into independent bounded history while AI is disabled',()=>{
 const state=emptyState();state.items=[story(1)];const job=planAnalysis(state)[0];applyAnalysis(state,job.key,result(job.key));delete (state as any).analysisHistory;
 planAnalysis(state);assert.equal(state.analysisHistory.length,1);state.items=[];state.unread=[];state.readStories=[];state.analysisPending=[];state.items=[story(1)];assert.equal(planAnalysis(state).length,0);
 const records=Array.from({length:10020},(_,n)=>({key:`cache-${n}`,savedAt:n,judgement:result(`cache-${n}`)}));mergeAnalysisHistory(state,records);assert.equal(state.analysisHistory.length,10000);
 mergeAnalysisHistory(state,Array.from({length:3000},(_,n)=>({key:`big-${n}`,savedAt:20000+n,judgement:{...result(`big-${n}`),reason:'字'.repeat(2000)}})));
 assert.ok(Buffer.byteLength(JSON.stringify(state.analysisHistory))<=4*1024*1024);assert.ok(state.analysisHistory.some(record=>record.key==='big-2999'));
});

test('coalescing combines staggered arrivals, sends a partial batch by its deadline, and a stop cancels collection',async t=>{
 t.mock.timers.enable({apis:['Date','setTimeout'],now:1700000000000});const state=emptyState();state.items=[story(1)];let enabled=true;const batches:BatchInput[][]=[];
 const queue=new AnalysisQueue({jobs:()=>planAnalysis(state),enabled:()=>enabled,coalesceMs:()=>2000,batchSize:()=>8,concurrency:()=>1,dispatch:async inputs=>{batches.push(inputs);return inputs.map(input=>({id:input.item.id,judgement:result(input.fingerprint)}));},apply:(key,j)=>{applyAnalysis(state,key,j);},changed:()=>{},error:e=>assert.fail(e)});t.after(()=>queue.stop());
 const advance=async(n:number)=>{t.mock.timers.tick(n);await setImmediate();};
 queue.wake();await advance(0);assert.equal(batches.length,0);await advance(1000);state.items.push(story(2));queue.wake();await advance(0);await advance(999);assert.equal(batches.length,0);await advance(1);assert.equal(batches.length,1);assert.equal(batches[0].length,2);
 await advance(0);state.items.push(story(3));queue.wake();await advance(0);enabled=false;queue.stop();await advance(3000);assert.equal(batches.length,1);
});
test('native capacity reduction preserves overflow jobs and does not dispatch oversized individual stories',async t=>{
 const state=emptyState();state.items=[story(1),story(2),story(3)];const sent:string[]=[];let errors=0;
 const queue=new AnalysisQueue({jobs:()=>planAnalysis(state),enabled:()=>true,batchSize:()=>8,concurrency:()=>1,maxRetries:()=>0,prepare:async inputs=>({count:inputs[0].item.body.includes(' 1%')?0:Math.min(1,inputs.length),chars:100}),dispatch:async inputs=>{sent.push(...inputs.map(input=>input.item.body));return inputs.map(input=>({id:input.item.id,judgement:result(input.fingerprint)}));},apply:(key,j)=>{applyAnalysis(state,key,j);},changed:()=>{},error:()=>errors++});t.after(()=>queue.stop());queue.wake();
 for(let n=0;n<100&&sent.length<2;n++)await new Promise(resolve=>setTimeout(resolve,5));
 assert.equal(sent.length,2);assert.equal(new Set(sent).size,2);assert.ok(sent.every(body=>!body.includes(' 1%')));assert.equal(errors,1);assert.equal(queue.failed,1);
});
test('time-decayed batch forecasts follow the configured window and never count re-planning as arrivals',()=>{
 const state=emptyState(),policy=new BatchPolicy(),now=Date.now();state.items=Array.from({length:12},(_,n)=>story(n));const jobs=planAnalysis(state);
 policy.observe(jobs,now);const initial=policy.estimate(state.preferences.aiLimits,20,12,60000,now);policy.observe(jobs,now+1000);const repeated=policy.estimate(state.preferences.aiLimits,20,12,60000,now+1000);
 assert.ok(repeated.rate<initial.rate);state.preferences.aiLimits.requestWindowMinutes=15;assert.equal(requestInterval(state.preferences.aiLimits),150000);
 const longer=policy.estimate(state.preferences.aiLimits,20,12,60000,now);assert.equal(longer.windowMs,900000);assert.notEqual(longer.rate,initial.rate);
 const narrow=policy.estimate(state.preferences.aiLimits,20,12,1000,now);assert.equal(narrow.capacity,1);assert.equal(narrow.target,1);
 assert.equal(policy.estimate(state.preferences.aiLimits,20,0,60000,now+900001).rate,0);
});

test('stop during asynchronous character preflight prevents dispatch and stale preflight cannot revive the queue',async t=>{
 const state=emptyState();state.items=[story(1)];let enabled=true,calls=0,finish:((value:{count:number;chars:number})=>void)|undefined;
 const queue=new AnalysisQueue({jobs:()=>planAnalysis(state),enabled:()=>enabled,batchSize:()=>8,concurrency:()=>1,prepare:()=>new Promise(resolve=>finish=resolve),dispatch:async()=>{calls++;return [];},apply:()=>{},changed:()=>{},error:e=>assert.fail(e)});t.after(()=>queue.stop());
 queue.wake();for(let n=0;n<100&&!finish;n++)await new Promise(resolve=>setTimeout(resolve,5));assert.ok(finish);
 enabled=false;queue.stop();finish({count:1,chars:100});await new Promise(resolve=>setTimeout(resolve,20));assert.equal(calls,0);assert.equal(queue.active,false);
});
