import {cacheHash,semanticText,text,type DiskState,type NewsItem,type PlaybackRecord} from './core';
// Playback completion is independent of the reader's explicit "mark read" action.
export class PlaybackHistory {
 private snapshot:PlaybackRecord[]|undefined;private records=new Set<string>();
 private keys=new WeakMap<NewsItem,{body:string;key:string}>();
 constructor(private state:()=>DiskState){}
 private key(item:NewsItem){const body=text(item),cached=this.keys.get(item);if(cached?.body===body)return cached.key;const key=cacheHash(semanticText(item));this.keys.set(item,{body,key});return key;}
 has(item:NewsItem):boolean{
  const history=this.state().playbackHistory;if(!history.length)return false;
  if(history!==this.snapshot){this.snapshot=history;this.records=new Set(history.map(record=>record.key));}
  return this.records.has(this.key(item));
 }
 complete(item:NewsItem,now=Date.now()):boolean{
  if(this.has(item))return false;const state=this.state(),retained=new Set([...state.items,...state.unread].map(i=>i.id));
  state.playbackHistory=[...state.playbackHistory.filter(record=>record.playedAt>=now-7*86400000||retained.has(record.id)),{id:item.id,key:this.key(item),publishedAt:item.publishedAt,playedAt:now}].slice(-10000);return true;
 }
}
