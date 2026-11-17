import { t } from './i18n';
import bundled from '../source-adapters/packages/preinstalled.json';
import {validatePluginSource} from './source-packages';
import type { AdapterRules, CustomSource, NewsItem, Preferences, Source } from './core';
export const sourceNames: Record<string,string> = Object.fromEntries(bundled.sources.map(p=>[p.manifest.id,p.manifest.name]));
export const sources = Object.keys(sourceNames);
export function catalogSources(prefs:Preferences):Source[] {return [...new Set([...sources,...prefs.customSources.map(s=>s.id)])];}
export function allSources(prefs:Preferences):Source[] {return catalogSources(prefs).filter(id=>!(prefs.uninstalledSources??[]).includes(id));}
export function sourceName(id:Source,prefs:Preferences):string {return prefs.customSources.find(s=>s.id===id)?.name ?? (Object.hasOwn(sourceNames,id)?sourceNames[id]:undefined) ?? t("已移除的来源");}
export function validSourceURL(input:string):boolean {
  try {
    const url=new URL(input.trim());
    return !url.username && !url.password && !url.hash && (url.protocol==='https:' || url.protocol==='http:' && ['localhost','127.0.0.1','[::1]'].includes(url.hostname))
      && ![...url.searchParams.keys()].some(k=>['key','apikey','token','accesstoken','authorization','password','secret'].includes(k.toLowerCase().replace(/[-_]/gu,'')));
  } catch {return false;}
}
export function validateSources(prefs:Preferences):string|undefined {
  if(prefs.customSources.length>200)return t("最多接入 200 个自定义来源");
  const ids=new Set<string>();const urls=new Set<string>();
  for(const s of prefs.customSources){
    if(s.format==='plugin'){const error=validatePluginSource(s);if(error)return error;if(ids.has(s.id))return t("渠道 ID 重复");ids.add(s.id);continue;}
    if(!/^custom:[a-zA-Z0-9_-]{1,73}$/u.test(s.id) || ids.has(s.id))return t("自定义来源 ID 无效或重复");
    ids.add(s.id);
    if(!s.name.trim() || [...s.name].length>32)return t("请填写来源名称（最多32字）");
    if(!validSourceURL(s.url))return t("请填写有效的来源 HTTPS URL（本地可用 HTTP），密钥请单独填写");
    const url=new URL(s.url).href;if(urls.has(url))return t("来源地址重复，请合并或移除重复订阅");urls.add(url);
    if(!['none','bearer'].includes(s.auth))return t("来源鉴权方式无效");
    if(!['auto','json','feed','adapter'].includes(s.format??'auto'))return t("来源格式无效");
    if(s.format==='adapter'){const error=validateAdapter(s.adapter);if(error)return error;}
    if([...(s.folder??'')].length>128)return t("来源分组最多128字");
  }
  if(prefs.customSources.reduce((sum,s)=>sum+new TextEncoder().encode(s.plugin?.script??'').length,0)>4*1024*1024)return t("本地渠道脚本累计最多 4 MiB");
  const known=catalogSources(prefs);
  if((prefs.uninstalledSources??[]).some(id=>!known.includes(id)) || new Set(prefs.uninstalledSources??[]).size!==(prefs.uninstalledSources??[]).length)return t("未安装渠道记录无效，请重新设置。");
  if(prefs.sources.some(id=>!allSources(prefs).includes(id)))return t("选择的消息来源无效，请重新设置。");
}
function parseStandard(source:Source,raw:string):NewsItem[] {
  const envelope=JSON.parse(raw);
  if(!envelope || envelope.version!==1 || !Array.isArray(envelope.items))throw new Error(t("自定义来源须返回 {\"version\":1,\"items\":[…]}"));
  if(envelope.items.length>500)throw new Error(t("单次最多返回 500 条快讯"));
  const ids=new Set<string>();
  return envelope.items.map((row:Record<string,unknown>,index:number)=>{
    const fail=()=>{throw new Error(t("第 {0} 条快讯格式无效：请检查 id、body、publishedAt、url、tags", index+1));};
    if(!row || typeof row!=='object' || typeof row.id!=='string' || !row.id.trim() || [...row.id].length>200 || ids.has(row.id))return fail();
    if(typeof row.body!=='string' || !row.body.trim() || [...row.body].length>32000 || row.title!==undefined && (typeof row.title!=='string' || [...row.title].length>1000))return fail();
    const publishedAt=typeof row.publishedAt==='number' ? row.publishedAt : typeof row.publishedAt==='string' && /T.*(?:Z|[+-]\d{2}:\d{2})$/u.test(row.publishedAt) ? Date.parse(row.publishedAt) : NaN;
    // Explicit epoch milliseconds, never guess seconds or a timezone.
    if(!Number.isFinite(publishedAt) || publishedAt<1_000_000_000_000 || publishedAt>Date.now()+86400_000)return fail();
    if(row.url!==undefined && typeof row.url!=='string')return fail();
    const url=(row.url as string|undefined)?.trim()??'';
    if(url){try{const u=new URL(url);if(!['https:','http:'].includes(u.protocol) || u.username || u.password)return fail();}catch{return fail();}}
    if(row.dateEstimated!==undefined&&typeof row.dateEstimated!=='boolean')return fail();
    const tags=row.tags??[];
    if(!Array.isArray(tags) || tags.length>8 || tags.some(t=>typeof t!=='string' || !t.trim() || [...t.trim()].length>24 || /[\r\n]/u.test(t)))return fail();
    ids.add(row.id);
    return {id:`${source}:${row.id}`,source,title:typeof row.title==='string'?row.title.trim():'',body:row.body.trim(),publishedAt,url,dateEstimated:row.dateEstimated===true,tags:[...new Set(tags.map(t=>t.trim()))]};
  });
}
export function parseFeed(source:Source,raw:string):NewsItem[]{try{return parseStandard(source,raw);}catch(error){if(error instanceof SyntaxError)throw new Error(t("新闻接口返回的不是有效 JSON"));throw error;}}
export function validateAdapter(value:unknown):string|undefined{
  if(!value||typeof value!=='object')return t("缺少本地适配器规则");
  const r=value as AdapterRules;
  const allowed=['itemsPath','idPath','titlePath','bodyPaths','datePath','dateUnit','timezone','urlPath','urlTemplate','tagsPath','jsonPrefix','exclude'];
  if(Object.keys(r).some(k=>!allowed.includes(k)))return t("适配器包含未知字段");
  if(!r.idPath||!r.datePath||!Array.isArray(r.bodyPaths)||!r.bodyPaths.length||r.bodyPaths.length>8||!['seconds','milliseconds','iso','local'].includes(r.dateUnit))return t("适配器需要 ID、正文和日期字段映射");
  const paths=[r.itemsPath,r.idPath,r.titlePath??'',r.datePath,r.urlPath??'',r.tagsPath??'',...r.bodyPaths];
  if(paths.some(p=>typeof p!=='string'||p.length>200||p.split('.').length>16||!/^[a-zA-Z0-9_.-]*$/u.test(p)))return t("适配器只支持点号字段路径与数组下标");
  if(r.dateUnit==='local'&&!/^[+-]\d{2}:\d{2}$/u.test(r.timezone??''))return t("适配器需要明确时区，如 +08:00");
}
