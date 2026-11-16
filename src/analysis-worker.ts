import {planAnalysis,applyAnalysisBatch,eligibleForAI,aiBodyBudget} from './analysis';
import {characterCount,currentJudgement,syncUnread,text,type AnalysisRecord,type DiskState,type NewsItem,type Judgement} from './core';
export interface WorkerRequest{id:number;operation:'plan'|'apply'|'sync';state:DiskState;hasKey:boolean;error?:string;results?:{key:string;judgement:Judgement}[]}
export interface VersionedItem{id:string;source:string;title:string;body:string;tags?:string[];judgement?:Judgement}
export interface WorkerResult {history:AnalysisRecord[];prunedHistory:{key:string;savedAt:number}[];jobs:ReturnType<typeof planAnalysis>;judgements:VersionedItem[];unread:VersionedItem[];cleared:VersionedItem[];skippedLong:number}
const version=(item:NewsItem):VersionedItem=>({id:item.id,source:item.source,title:item.title,body:item.body,tags:item.tags,judgement:item.judgement});
const scope=globalThis as unknown as {onmessage:(event:MessageEvent<WorkerRequest>)=>void;postMessage:(value:unknown)=>void};
scope.onmessage=({data})=>{
 try{
  const {state,operation}=data,all=[...new Set([...state.items,...state.unread,...state.readStories,...state.analysisPending])];
  const beforeHistory=new Map((state.analysisHistory??[]).map(record=>[record.key,record.savedAt]));
  const before=new Map(all.map(item=>[item,item.judgement]));
  const oldUnread=new Map(state.unread.map(item=>[item.id,text(item)])),oldPending=[...state.analysisPending];
  if(operation==='apply')applyAnalysisBatch(state,data.results??[]);
  const planned=planAnalysis(state);const jobs=operation==='plan'?planned:[];
  syncUnread(state,data.hasKey,data.error);
  const current=new Map([...state.analysisPending,...state.items].map(item=>[item.id,item]));
  state.analysisPending=state.analysisPending.filter(item=>eligibleForAI(item,state)&&!currentJudgement(current.get(item.id)??item,state.preferences));
  const retained=new Set(state.analysisPending.map(item=>item.id));
  const keptHistory=new Set(state.analysisHistory.map(record=>record.key));
  const result:WorkerResult={history:state.analysisHistory.filter(record=>beforeHistory.get(record.key)!==record.savedAt),prunedHistory:[...beforeHistory].filter(([key])=>!keptHistory.has(key)).map(([key,savedAt])=>({key,savedAt})),jobs,judgements:all.filter(item=>item.judgement!==before.get(item)).map(version),unread:state.unread.filter(item=>oldUnread.get(item.id)!==text(item)).map(version),cleared:oldPending.filter(item=>!retained.has(item.id)).map(version),skippedLong:state.items.filter(item=>eligibleForAI(item,state)&&characterCount(text(item))>aiBodyBudget(state)).length};
  scope.postMessage({id:data.id,result});
 }catch(error){scope.postMessage({id:data.id,error:error instanceof Error?error.message:'AI 任务准备失败'});}
};
