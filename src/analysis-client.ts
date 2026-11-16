import AnalysisThread from './analysis-worker?worker&inline';
import {relevanceConfig,type DiskState,type NewsItem,type Judgement} from './core';
import type {AnalysisJob} from './analysis';
import type {WorkerRequest,WorkerResult,VersionedItem} from './analysis-worker';
const profile=(state:DiskState)=>JSON.stringify([relevanceConfig(state.preferences),state.preferences.interests]);
const matches=(item:NewsItem,version:VersionedItem)=>item.source===version.source&&item.title===version.title&&item.body===version.body&&JSON.stringify(item.tags??[])===JSON.stringify(version.tags??[]);
export class AnalysisClient {
 private worker:Worker|null=null;private next=0;private requests=new Map<number,{resolve:(result:WorkerResult)=>void;reject:(error:string)=>void}>();
 skippedLong=0;private generation=0;
 invalidate(){this.generation++;}
 constructor(private current:()=>DiskState,private changed:()=>void){}
 private thread(){
  if(!this.worker){this.worker=new AnalysisThread();this.worker.onmessage=({data})=>{const request=this.requests.get(data.id);if(!request)return;this.requests.delete(data.id);if(data.error)request.reject(data.error);else request.resolve(data.result);};this.worker.onerror=()=>{for(const request of this.requests.values())request.reject('AI 任务准备失败，请暂停后重试');this.requests.clear();this.worker?.terminate();this.worker=null;};}
  return this.worker;
 }
 private async run(operation:WorkerRequest['operation'],hasKey:boolean,error?:string,results?:WorkerRequest['results']):Promise<AnalysisJob[]>{
  const state=this.current(),context=profile(state),readStories=state.readStories,generation=this.generation;
  // No credentials or source scripts enter the worker. Structured cloning runs once per batch.
  const snapshot={...state,playbackHistory:[],preferences:{...state.preferences,customSources:[]}};
  const id=++this.next;const response=await new Promise<WorkerResult>((resolve,reject)=>{this.requests.set(id,{resolve,reject});this.thread().postMessage({id,operation,state:snapshot,hasKey,error,results} satisfies WorkerRequest);});
  const live=this.current();if(generation!==this.generation||context!==profile(live))return [];
  // The worker prunes/encodes history. Applying its patch here only merges small records.
  const history=new Map((live.analysisHistory??[]).map(record=>[record.key,record]));
  for(const record of response.prunedHistory)if(history.get(record.key)?.savedAt===record.savedAt)history.delete(record.key);
  for(const record of response.history){const old=history.get(record.key);if(!old||old.savedAt<record.savedAt)history.set(record.key,record);}
  if(response.history.length||response.prunedHistory.length)live.analysisHistory=[...history.values()].slice(-10000);
  const copies=new Map<string,NewsItem[]>();for(const item of [...live.items,...live.unread,...live.analysisPending,...live.readStories]){const list=copies.get(item.id)??[];list.push(item);copies.set(item.id,list);}
  for(const patch of response.judgements)for(const item of copies.get(patch.id)??[])if(matches(item,patch))item.judgement=patch.judgement;
  if(response.unread.length&&readStories===live.readStories){const unread=new Map(live.unread.map(item=>[item.id,item]));for(const patch of response.unread){const item=(copies.get(patch.id)??[]).find(item=>matches(item,patch));if(item)unread.set(item.id,item);}live.unread=[...unread.values()];}
  const oldPending=live.analysisPending.length;
  const cleared=new Map(response.cleared.map(item=>[item.id,item]));live.analysisPending=live.analysisPending.filter(item=>!cleared.has(item.id)||!matches(item,cleared.get(item.id)!));
  this.skippedLong=response.skippedLong;if(response.history.length||response.prunedHistory.length||response.judgements.length||response.unread.length||oldPending!==live.analysisPending.length)this.changed();
  return response.jobs.filter(job=>job.members.every(member=>(copies.get(member.id)??[]).some(item=>matches(item,member)))&&job.members.every(member=>live.preferences.sources.includes(member.source)));
 }
 plan(hasKey:boolean,error?:string){return this.run('plan',hasKey,error);}
 async apply(results:{key:string;judgement:Judgement}[],hasKey:boolean,error?:string){await this.run('apply',hasKey,error,results);}
 async sync(hasKey:boolean,error?:string){await this.run('sync',hasKey,error);}
}
