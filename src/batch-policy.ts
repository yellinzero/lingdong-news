import type {AnalysisJob} from './analysis';
import type {AILimits} from './core';

export function requestInterval(limits:AILimits){return Math.ceil((limits.requestWindowMinutes??1)*60000/limits.maxRequestsPerMinute);}

// Time-decayed arrival counts; re-planning the same job is never a new arrival.
export class BatchPolicy {
 private seen=new Map<string,number>();
 private samples:{at:number;count:number;chars:number}[]=[];
 observe(jobs:AnalysisJob[],now=Date.now()){
  const current=new Set(jobs.map(job=>job.key));
  for(const [key,at] of this.seen)if(at<now-3600000&&!current.has(key))this.seen.delete(key);
  let count=0,chars=0;
  for(const job of jobs)if(!this.seen.has(job.key)){this.seen.set(job.key,now);count++;chars+=job.item.body.length;}
  this.samples=this.samples.filter(sample=>sample.at>=now-3600000);
  if(count){const last=this.samples.at(-1);if(last&&last.at===now){last.count+=count;last.chars+=chars;}else this.samples.push({at:now,count,chars});}
 }
 estimate(limits:AILimits,maxBatch:number,backlog:number,bodyBudget:number,now=Date.now()){
  const window=(limits.requestWindowMinutes??1)*60000,interval=requestInterval(limits);
  // Half-life follows both configured window and cadence, never a fixed 15 minutes.
  const halfLife=Math.sqrt(window*interval),tau=halfLife/Math.LN2;
  let weightedCount=0,weightedChars=0;
  for(const sample of this.samples){const age=now-sample.at;if(age<0||age>=window)continue;const weight=Math.exp(-age/tau);weightedCount+=sample.count*weight;weightedChars+=sample.chars*weight;}
  const rate=weightedCount/(tau*(1-Math.exp(-window/tau)));
  const averageChars=weightedCount?weightedChars/weightedCount:0;
  const capacity=Math.max(1,Math.min(maxBatch,averageChars?Math.floor(bodyBudget/(averageChars+600)):maxBatch));
  const forecast=rate*interval,drain=backlog/limits.maxRequestsPerMinute;
  const target=Math.min(capacity,Math.max(Math.min(2,maxBatch),Math.ceil(forecast+drain)));
  return {windowMs:window,intervalMs:interval,rate,averageChars,target,capacity};
 }
 waitMs(limits:AILimits,maxBatch:number,backlog:number,bodyBudget:number,now=Date.now()){
  const estimate=this.estimate(limits,maxBatch,backlog,bodyBudget,now);
  if(backlog>=estimate.target)return 0;
  return estimate.rate?Math.min(2000,Math.ceil((estimate.target-backlog)/estimate.rate)):2000;
 }
}
