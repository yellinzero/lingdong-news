import {validSourceURL,validateAdapter,sources,allSources} from './feeds';
import {isInstalled} from './channels';
import {channelSource,packageSource,typedParameter,validatePackage,validatePluginSource} from './source-packages';
import type {CustomSource,Preferences} from './core';
export const maxSources=200;
function canonical(url:string){return new URL(url.trim()).href;}
export interface ImportPreview {sources:CustomSource[];updates:CustomSource[];reinstalls:string[];duplicates:number;issues:string[]}
export function installationCount(preview:ImportPreview):number {return preview.sources.length+preview.updates.length+preview.reinstalls.length;}
export function previewSubscriptions(input:string,prefs:Preferences):ImportPreview{
  const result:ImportPreview={sources:[],updates:[],reinstalls:[],duplicates:0,issues:[]};
  if(new TextEncoder().encode(input).length>1024*1024)return {...result,issues:['导入内容最多1 MiB']};
  const candidates:{id?:string;name:string;url:string;folder:string;format:CustomSource['format'];auth:CustomSource['auth'];adapter?:CustomSource['adapter'];enabled?:boolean}[]=[];
  const builtinCandidates:string[]=[];
  const pluginCandidates:{source:CustomSource;parametersProvided:boolean}[]=[];
  const value=input.trim();
  if(value.startsWith('<')){
    if(/<!DOCTYPE|<!ENTITY/iu.test(value))return {...result,issues:['OPML 不支持 XML 实体声明']};
    const xml=new DOMParser().parseFromString(value,'application/xml');
    if(xml.querySelector('parsererror')||xml.documentElement.localName!=='opml')return {...result,issues:['文件不是有效的 OPML 订阅列表']};
    for(const outline of xml.querySelectorAll('outline[xmlUrl]')){
      const groups:string[]=[];let parent=outline.parentElement;
      while(parent?.localName==='outline'){const label=parent.getAttribute('text')||parent.getAttribute('title');if(label)groups.unshift(label);parent=parent.parentElement;}
      const format=outline.getAttributeNS('https://newsfloat.local/opml','format')??'auto';
      candidates.push({name:outline.getAttribute('title')||outline.getAttribute('text')||'',url:outline.getAttribute('xmlUrl')||'',folder:groups.join(' / '),format:format as CustomSource['format'],auth:outline.getAttributeNS('https://newsfloat.local/opml','auth')==='bearer'?'bearer':'none'});
    }
    if(!candidates.length)result.issues.push('OPML 中没有 xmlUrl 订阅地址');
  }else if(value.startsWith('{')){
    try{
      const directory=JSON.parse(value);if(![1,2].includes(directory.version)||!Array.isArray(directory.sources))throw new Error();
      for(const entry of directory.sources){
        if(!entry||typeof entry!=='object'||Array.isArray(entry))throw new Error();
        if(directory.version===2&&('manifest' in entry||'script' in entry)){
          if(Object.keys(entry).some(key=>!['manifest','script','parameters'].includes(key)))return {...result,issues:['渠道包包含未知字段']};
          const plugin={manifest:entry.manifest,script:entry.script};const error=validatePackage(plugin);if(error)return {...result,issues:[error]};
          const source=packageSource(plugin);if(entry.parameters!==undefined){if(!entry.parameters||typeof entry.parameters!=='object'||Array.isArray(entry.parameters))return {...result,issues:['parameters 必须为配置对象']};source.parameters={...source.parameters,...entry.parameters};}
          const sourceError=validatePluginSource(source);if(sourceError)return {...result,issues:[sourceError]};
          pluginCandidates.push({source,parametersProvided:entry.parameters!==undefined});continue;
        }
        if(Object.keys(entry).some(key=>!['id','name','url','folder','format','auth','adapter','builtin'].includes(key)))return {...result,issues:['渠道文件包含不支持的字段；逻辑渠道请使用 version:2 的 manifest + script 格式']};
        if('builtin' in entry){if(!sources.includes(entry.builtin)||Object.keys(entry).length!==1)return {...result,issues:['内置渠道须使用 {"builtin":"cls"}、wallstreet 或 jin10，不能覆盖请求配置']};builtinCandidates.push(entry.builtin);continue;}
        if(typeof entry.name!=='string'||typeof entry.url!=='string'||entry.id!==undefined&&(typeof entry.id!=='string'||!/^custom:[a-zA-Z0-9_-]{1,73}$/u.test(entry.id)))throw new Error();
        candidates.push({id:entry.id,name:entry.name,url:entry.url,folder:typeof entry.folder==='string'?entry.folder:'',format:entry.format??'auto',auth:entry.auth??'none',adapter:entry.adapter});
      }
    }catch{return {...result,issues:['文件须为 version:1 或 version:2 的 sources 渠道列表']};}
  }else{
    for(const line of value.split(/\r?\n/u).map(s=>s.trim()).filter(Boolean)){
      if(line.startsWith('#'))continue;
      const pair=line.match(/^(.+?)\s*[|\t]\s*(https?:\/\/.*)$/u);
      candidates.push({name:pair?.[1].trim()??'',url:pair?.[2].trim()??line,folder:'',format:'auto',auth:'none'});
    }
  }
  const restored=new Set<string>();
  for(const id of builtinCandidates){if(isInstalled(prefs,id)||restored.has(id))result.duplicates++;else{restored.add(id);result.reinstalls.push(id);}}
  const knownURLs=new Map(prefs.customSources.filter(s=>s.format!=='plugin'&&validSourceURL(s.url)).map(s=>[canonical(s.url),s]));
  const seen=new Set<string>();const seenIDs=new Map(prefs.customSources.map(s=>[s.id,validSourceURL(s.url)?canonical(s.url):s.url]));
  for(const [index,candidate] of candidates.entries()){
    if(!validSourceURL(candidate.url)||!['auto','json','feed','adapter'].includes(candidate.format??'auto')||!['none','bearer'].includes(candidate.auth)) {result.issues.push(`第${index+1}个来源无效，请检查地址、格式或独立鉴权配置`);continue;}
    if(candidate.format==='adapter'||candidate.adapter!==undefined){const error=validateAdapter(candidate.adapter);if(error){result.issues.push(`第${index+1}个来源：${error}`);continue;}}
    const url=canonical(candidate.url);
    if(candidate.id&&seenIDs.has(candidate.id)&&seenIDs.get(candidate.id)!==url){result.issues.push(`第${index+1}个来源 ID 已用于其他地址，请勿覆盖已有渠道`);continue;}
    if(seen.has(url)){result.duplicates++;continue;}
    seen.add(url);
    const existing=knownURLs.get(url);
    if(existing){if(isInstalled(prefs,existing.id)||restored.has(existing.id))result.duplicates++;else{restored.add(existing.id);result.reinstalls.push(existing.id);}continue;}
    if(prefs.customSources.length+result.sources.length>=maxSources){result.issues.push('已达到200个自定义来源上限');break;}
    const id=candidate.id??`custom:${(globalThis.crypto?.randomUUID?.()??`${Date.now().toString(36)}-${Math.random().toString(36).slice(2,12)}`)}`;seenIDs.set(id,url);
    result.sources.push({id,name:(candidate.name||new URL(url).hostname).trim().slice(0,32),url,folder:candidate.folder.slice(0,128),format:candidate.format??'auto',auth:candidate.auth,...(candidate.adapter?{adapter:candidate.adapter}:{})});
  }
  const packageIDs=new Set<string>();
  const stable=(value:unknown):string=>JSON.stringify(value,(_,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(key=>[key,v[key]])):v);
  for(const {source,parametersProvided} of pluginCandidates){
    const previous=channelSource(source.id,prefs);
    if(packageIDs.has(source.id)||result.sources.some(s=>s.id===source.id)){result.issues.push(`渠道 ID 重复：${source.id}`);continue;}packageIDs.add(source.id);
    if(previous?.plugin){
      const a=source.plugin!.manifest.version.split('.').map(BigInt),b=previous.plugin.manifest.version.split('.').map(BigInt);
      const difference=a.map((n,i)=>n>b[i]?1:n<b[i]?-1:0).find(n=>n!==0)??0;
      if(difference<0){result.issues.push(`${source.name}：不能用低版本覆盖 ${previous.plugin.manifest.version}`);continue;}
      if(!parametersProvided)for(const field of source.plugin!.manifest.config){const value=previous.parameters?.[field.key];if(typedParameter(field,value))source.parameters![field.key]=value!;}
      if(stable(previous.plugin)===stable(source.plugin)&&stable(previous.parameters??{})===stable(source.parameters??{})){
        if(isInstalled(prefs,source.id)||restored.has(source.id))result.duplicates++;else{restored.add(source.id);result.reinstalls.push(source.id);}continue;
      }
    }
    if(previous){result.reinstalls=result.reinstalls.filter(id=>id!==source.id);result.updates.push(source);continue;}
    if(prefs.customSources.length+result.sources.length>=maxSources){result.issues.push('已达到200个自定义来源上限');continue;}
    result.sources.push(source);
  }
  return result;
}
function escape(value:string){return value.replace(/&/gu,'&amp;').replace(/</gu,'&lt;').replace(/>/gu,'&gt;').replace(/"/gu,'&quot;').replace(/'/gu,'&apos;');}
export function exportOPML(sources:CustomSource[]):string{
  const outlines=sources.filter(s=>validSourceURL(s.url)&&s.format!=='adapter'&&s.format!=='plugin').map(s=>{
    const item=`<outline text="${escape(s.name)}" title="${escape(s.name)}" type="rss" xmlUrl="${escape(canonical(s.url))}" nf:format="${s.format??'auto'}" nf:auth="${s.auth}"/>`;
    return s.folder?`    <outline text="${escape(s.folder)}">${item}</outline>`:`    ${item}`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<opml version="2.0" xmlns:nf="https://newsfloat.local/opml">\n  <head><title>NewsFloat 订阅列表</title></head>\n  <body>\n${outlines.join('\n')}\n  </body>\n</opml>\n`;
}

export function exportChannelDirectory(prefs:Preferences):string {
  return JSON.stringify({version:2,sources:allSources(prefs).map(id=>{
    const source=channelSource(id,prefs)!;
    if(source.plugin)return {...source.plugin,parameters:source.parameters??{}};
    const {name,url,format,folder,auth,adapter}=source;
    return {id,name,url,format:format??'auto',folder,auth,...(adapter?{adapter}:{})};
  })},null,2);
}
