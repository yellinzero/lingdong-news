import { characterCount, cacheHash, currentJudgement, fingerprint, relevanceConfig, semanticText, syncUnread, text, type AnalysisRecord, type DiskState, type Judgement, type NewsItem } from './core';
export interface AnalysisJob { key:string; item:NewsItem; members:NewsItem[] }
export interface BatchInput {item:NewsItem;fingerprint:string}
export interface BatchJudgement {id:string;judgement:Judgement}
export function mergeAnalysisHistory(state:DiskState,records:AnalysisRecord[]=[]):boolean {
 const old=state.analysisHistory??[],map=new Map(old.map(record=>[record.key,record]));let changed=!state.analysisHistory;
 for(const record of records){if(record.judgement.contextFingerprint!==record.key)continue;const previous=map.get(record.key);if(!previous||previous.savedAt<record.savedAt){map.set(record.key,record);changed=true;}}
 const kept:AnalysisRecord[]=[];let bytes=2;const encoder=new TextEncoder();
 for(const record of [...map.values()].sort((a,b)=>b.savedAt-a.savedAt||a.key.localeCompare(b.key))){
  const size=encoder.encode(JSON.stringify(record)).byteLength+(kept.length?1:0);
  if(kept.length>=10000||bytes+size>4*1024*1024){changed=true;continue;}kept.push(record);bytes+=size;
 }
 if(changed)state.analysisHistory=kept.reverse();return changed;
}
export function eligibleForAI(item:NewsItem,state:DiskState,now=Date.now()):boolean {
 const l=state.preferences.aiLimits,date=Math.max(item.publishedAt,item.updatedAt??0),cutoff=Math.max(now-l.lookbackMinutes*60000,l.newOnly?state.preferences.aiStartedAt:0);
 return (l.includeEstimated||!item.dateEstimated)&&date>=cutoff&&date<=now+60000;
}
export function aiBodyBudget(state:DiskState):number{return Math.min(state.preferences.aiLimits.maxCharsPerRequest,state.preferences.aiLimits.maxInputCharsPerMinute);}
// Exact semantic duplicates share work, even across source IDs. Near-duplicates
// can share a display row, but each distinct version is judged, preserving details.
export function syncAnalysisPending(state:DiskState,incoming:NewsItem[]=[]){
  if(!state.preferences.aiEnabled||!state.preferences.interests.trim())return;
  const map=new Map(state.analysisPending.filter(i=>eligibleForAI(i,state)).map(i=>[i.id,i]));
  for(const item of [...state.items,...incoming])if(state.preferences.sources.includes(item.source)&&eligibleForAI(item,state))map.set(item.id,item);
  state.analysisPending=[...map.values()];
}
export function planAnalysis(state:DiskState,onReuse?:()=>void):AnalysisJob[]{
  const existing=new Set((state.analysisHistory??[]).map(record=>record.key));const migrated:AnalysisRecord[]=[];
  for(const item of [...state.items,...state.unread,...state.readStories,...state.analysisPending]){const j=item.judgement;if(j?.contextFingerprint&&!existing.has(j.contextFingerprint)){migrated.push({key:j.contextFingerprint,judgement:j,savedAt:Date.now()});existing.add(j.contextFingerprint);}}
  mergeAnalysisHistory(state,migrated);
  const originals=new Map(state.analysisPending.map(i=>[i.id,i]));for(const item of state.items)originals.set(item.id,item);
  let reused=false;
  const buckets=new Map<string,NewsItem[]>();
  for(const item of originals.values()){if(!state.preferences.sources.includes(item.source))continue;const key=semanticText(item);const list=buckets.get(key)??[];list.push(item);buckets.set(key,list);}
  const cache=new Map<string,Judgement>((state.analysisHistory??[]).map(record=>[record.key,record.judgement]));
  for(const item of [...state.items,...state.unread,...state.readStories,...state.analysisPending]){
    const j=item.judgement;if(j?.contextFingerprint)cache.set(j.contextFingerprint,j);
  }
  const jobs:AnalysisJob[]=[];
  for(const [semantic,members] of buckets){
    const tags=[...new Set(members.flatMap(i=>i.tags??[]))].sort();
    const key=cacheHash(JSON.stringify(['analysis-v1',relevanceConfig(state.preferences),state.preferences.interests,semantic,tags]));
    const cached=cache.get(key);
    if(cached){for(const item of members)if(currentJudgement(item,state.preferences)?.contextFingerprint!==key){item.judgement={...cached,fingerprint:fingerprint(item,state.preferences)};reused=true;}continue;}
    const eligible=members.filter(item=>eligibleForAI(item,state)&&characterCount(text(item))<=aiBodyBudget(state));if(!eligible.length)continue;
    const representative=eligible.reduce((a,b)=>text(a).length>=text(b).length?a:b);
    jobs.push({key,item:{...representative,id:`job:${key}`,title:'',body:text(representative),tags,judgement:undefined},members});
  }
  if(reused){syncUnread(state,true);state.analysisPending=state.analysisPending.filter(i=>!currentJudgement(originals.get(i.id)??i,state.preferences));onReuse?.();}
  return jobs.sort((a,b)=>b.item.publishedAt-a.item.publishedAt);
}
export function applyAnalysisBatch(state:DiskState,results:{key:string;judgement:Judgement}[]):boolean{
 const jobs=new Map(planAnalysis(state).map(job=>[job.key,job]));let applied=false;const ids=new Set<string>();
 const records:AnalysisRecord[]=[];
 for(const {key,judgement} of results){const job=jobs.get(key);if(!job)continue;const saved={...judgement,contextFingerprint:key};records.push({key,judgement:saved,savedAt:Date.now()});for(const item of job.members){item.judgement={...saved,fingerprint:fingerprint(item,state.preferences)};ids.add(item.id);}applied=true;}
 mergeAnalysisHistory(state,records);
 if(applied){syncUnread(state,true);state.analysisPending=state.analysisPending.filter(item=>!ids.has(item.id));}return applied;
}
export function applyAnalysis(state:DiskState,jobKey:string,result:Judgement):boolean{return applyAnalysisBatch(state,[{key:jobKey,judgement:result}]);}
interface QueueOptions {
  coalesceMs?:(jobs:AnalysisJob[])=>number;prepare?:(inputs:BatchInput[])=>Promise<{count:number;chars:number}>;minIntervalMs?:()=>number;
  jobs:()=>AnalysisJob[]|Promise<AnalysisJob[]>;maxRetries?:()=>number;maxChars?:()=>number;enabled:()=>boolean;batchSize:()=>number;concurrency:()=>number;
  dispatch:(inputs:BatchInput[])=>Promise<BatchJudgement[]>;
  apply:(key:string,result:Judgement)=>void;applyBatch?:(results:{key:string;judgement:Judgement}[])=>Promise<void>;changed:()=>void;error:(message:string)=>void;
}
export class AnalysisQueue {
  private collectSince:number|undefined;
  private lastDispatchAt=0;private cooldownUntil=0;
  private inFlight=new Set<string>();private running=0;private epoch=0;private planning=false;private packing=false;
  private failures=new Map<string,{attempts:number;retryAt:number}>();
  private timer:ReturnType<typeof setTimeout>|undefined;
  constructor(private options:QueueOptions){}
  get waitUntil(){return Math.max(this.cooldownUntil,this.lastDispatchAt?this.lastDispatchAt+(this.options.minIntervalMs?.()??0):0);}
  wake(){if(this.timer!==undefined)clearTimeout(this.timer);this.timer=undefined;this.schedule(0);}
  get active(){return this.running>0||this.planning||this.packing;}
  stop(){this.collectSince=undefined;this.epoch++;if(this.timer!==undefined)clearTimeout(this.timer);this.timer=undefined;}
  get failed(){return [...this.failures.values()].filter(f=>f.attempts>=(this.options.maxRetries?.()??1)+1).length;}
  schedule(delay=150){this.collectSince??=Date.now();if(this.timer!==undefined)return;this.timer=setTimeout(()=>{this.timer=undefined;void this.pump();},delay);}
  reset(){this.collectSince=undefined;this.epoch++;this.failures.clear();if(this.timer!==undefined)clearTimeout(this.timer);this.timer=undefined;this.schedule();}
  retry(){this.failures.clear();this.wake();}
  private async pump(){
    if(!this.options.enabled()){this.collectSince=undefined;return;}if(this.planning||this.packing)return;
    if(Date.now()<this.waitUntil){this.schedule(Math.max(1,this.waitUntil-Date.now()));this.options.changed();return;}
    const epoch=this.epoch;this.planning=true;this.options.changed();let jobs:AnalysisJob[];
    try{jobs=await this.options.jobs();}catch(error){this.options.error(typeof error==='string'?error:'AI 任务准备未完成');return;}finally{this.planning=false;this.options.changed();}
    if(epoch!==this.epoch||!this.options.enabled())return;
    const now=Date.now(),attemptLimit=(this.options.maxRetries?.()??1)+1;
    // Bound retained error records; fresh arrivals never erase current failures.
    const wanted=new Set(jobs.map(j=>j.key));for(const key of this.failures.keys())if(!wanted.has(key))this.failures.delete(key);
    const available=jobs.filter(j=>!this.inFlight.has(j.key)&&(!this.failures.has(j.key)||(this.failures.get(j.key)!.attempts<attemptLimit&&now>=this.failures.get(j.key)!.retryAt)));
    if(!available.length)this.collectSince=undefined;
    while(this.running<Math.max(1,this.options.concurrency())&&available.length){
      const batch:AnalysisJob[]=[];let chars=0;
      while(available.length&&batch.length<Math.max(1,this.options.batchSize())){
        const next=available[0],length=next.item.body.length+600;
        if(!this.options.prepare&&batch.length&&chars+length>(this.options.maxChars?.()??24000))break;
        batch.push(available.shift()!);chars+=length;
      }
      const until=(this.collectSince??=now)+(this.options.coalesceMs?.([...batch,...available])??0);
      const partial=batch.length<Math.max(1,this.options.batchSize())&&!available.length;
      if(partial&&Date.now()<until){this.schedule(until-Date.now());break;}
      if(this.options.prepare){
        this.packing=true;let capacity:{count:number;chars:number};
        try{capacity=await this.options.prepare(batch.map(job=>({item:job.item,fingerprint:job.key})));}
        catch(error){if(epoch===this.epoch){for(const job of batch)this.failures.set(job.key,{attempts:attemptLimit,retryAt:0});this.options.error(typeof error==='string'?error:'AI 批次检查未完成');}return;}
        finally{this.packing=false;this.schedule(0);}
        if(epoch!==this.epoch||!this.options.enabled())return;
        if(capacity.count<0||capacity.count>batch.length||!Number.isInteger(capacity.count)){this.options.error('AI 批次检查结果无效');return;}
        if(!capacity.count){this.failures.set(batch[0].key,{attempts:attemptLimit,retryAt:0});this.options.error('一条新闻超过单次字符上限，保留原文；其余新闻继续判断');available.unshift(...batch.slice(1));continue;}
        available.unshift(...batch.splice(capacity.count));
      }
      this.collectSince=undefined;
      for(const job of batch)this.inFlight.add(job.key); // reserve before awaiting
      this.lastDispatchAt=Date.now();this.running++;this.options.changed();void this.run(batch,this.epoch);
      if((this.options.minIntervalMs?.()??0)>0){if(available.length)this.schedule(0);break;}
    }
    const future=[...this.failures.values()].filter(f=>f.attempts<attemptLimit&&f.retryAt>now);
    if(future.length&&this.running<this.options.concurrency())this.schedule(Math.max(50,Math.min(...future.map(f=>f.retryAt-now))));
  }
  private async run(batch:AnalysisJob[],epoch:number){
    try{
      const results=await this.options.dispatch(batch.map(j=>({item:j.item,fingerprint:j.key})));
      if(epoch!==this.epoch)return;
      const expected=new Map(batch.map(j=>[j.item.id,j]));const seen=new Set<string>();
      if(results.length!==batch.length)throw 'AI 返回数量不符，保留待处理';
      for(const result of results){if(!expected.has(result.id)||seen.has(result.id)||result.judgement.fingerprint!==expected.get(result.id)!.key)throw 'AI 返回重复或无法对应的新闻 ID，保留待处理';seen.add(result.id);}
      const mapped=results.map(result=>({key:expected.get(result.id)!.key,judgement:result.judgement}));
      if(this.options.applyBatch)await this.options.applyBatch(mapped);else for(const result of mapped)this.options.apply(result.key,result.judgement);
      for(const result of mapped)this.failures.delete(result.key);
    }catch(error){
      if(epoch===this.epoch){
        const message=typeof error==='string'?error:'AI 调用未完成，保留待处理';
        const wait=/^AI_WAIT:(\d+)$/u.exec(message),provider=/^AI_PROVIDER_WAIT:(\d+):(.*)$/u.exec(message);
        if(wait){this.cooldownUntil=Math.max(this.cooldownUntil,Number(wait[1]));this.lastDispatchAt=0;return;}
        if(provider)this.cooldownUntil=Math.max(this.cooldownUntil,Number(provider[1]));
        for(const job of batch){const attempts=(this.failures.get(job.key)?.attempts??0)+1;this.failures.set(job.key,{attempts,retryAt:Date.now()+2000});}this.options.error(provider?provider[2]:message);}
    }finally{
      for(const job of batch)this.inFlight.delete(job.key);this.running--;this.options.changed();this.schedule(0);
    }
  }
}
