import { t } from './i18n';
import bundled from '../source-adapters/packages/preinstalled.json';
import {validSourceURL} from './feeds';
import type {CustomSource,PluginPackage,PluginField,Preferences} from './core';
export const preinstalledPackages=bundled.sources as PluginPackage[];
export function packageSource(plugin:PluginPackage):CustomSource {
  plugin=structuredClone(plugin);
  return {id:plugin.manifest.id,name:plugin.manifest.name,url:plugin.manifest.auth?.origin??plugin.manifest.network[0],auth:plugin.manifest.auth?'bearer':'none',format:'plugin',folder:'',plugin,parameters:Object.fromEntries(plugin.manifest.config.map(field=>[field.key,field.default]))};
}
export function channelSource(id:string,prefs:Preferences):CustomSource|undefined {
  const stored=prefs.customSources.find(source=>source.id===id);if(stored)return stored;
  const bundled=preinstalledPackages.find(p=>p.manifest.id===id);return bundled?packageSource(bundled):undefined;
}
export function typedParameter(field:PluginField,value:unknown):boolean {
  return field.kind==='string'?typeof value==='string'&&new TextEncoder().encode(value).length<=8000&&(!field.required||!!value.trim()):field.kind==='number'?typeof value==='number'&&Number.isFinite(value):field.kind==='boolean'&&typeof value==='boolean';
}
function only(value:object,keys:string[]):boolean{return Object.keys(value).every(key=>keys.includes(key));}
export function validatePackage(value:unknown):string|undefined {
  const fail=t("渠道包 manifest 或 script 无效，请检查渠道开发规范");
  if(!value||typeof value!=='object'||!only(value,['manifest','script']))return fail;
  const p=value as PluginPackage,m=p.manifest;
  if(typeof p.script!=='string'||!p.script.trim()||new TextEncoder().encode(p.script).length>256*1024||!m||typeof m!=='object'||!only(m,['id','name','version','apiVersion','entry','network','config','auth']))return fail;
  if(!/^(?:cls|wallstreet|jin10|custom:[a-zA-Z0-9_-]{1,73})$/u.test(m.id)||typeof m.name!=='string'||!m.name.trim()||[...m.name].length>32||typeof m.version!=='string'||m.version.length>40||!/^\d+\.\d+\.\d+$/u.test(m.version)||m.apiVersion!==1||m.entry!=='adapter.js')return fail;
  if(!Array.isArray(m.network)||!m.network.length||m.network.length>16||new Set(m.network).size!==m.network.length||m.network.some(origin=>typeof origin!=='string'||origin.includes('*')||!validSourceURL(origin)||new URL(origin).origin!==origin))return t("network 必须是完整 origin 列表，如 https://example.com；不支持通配符");
  if(!Array.isArray(m.config)||m.config.length>32)return fail;
  const keys=new Set<string>();
  for(const f of m.config){if(!f||typeof f!=='object'||!only(f,['key','label','kind','default','required'])||typeof f.key!=='string'||!/^[a-zA-Z0-9_]{1,64}$/u.test(f.key)||['__proto__','constructor','prototype'].includes(f.key)||keys.has(f.key)||typeof f.label!=='string'||!f.label.trim()||[...f.label].length>64||f.required!==undefined&&typeof f.required!=='boolean'||!typedParameter(f,f.default))return fail;keys.add(f.key);}
  if(m.auth&&(!only(m.auth,['origin','header','prefix'])||!m.network.includes(m.auth.origin)||!['Authorization','x-api-key'].includes(m.auth.header)||m.auth.prefix!==undefined&&(typeof m.auth.prefix!=='string'||new TextEncoder().encode(m.auth.prefix).length>64||/[\r\n]/u.test(m.auth.prefix))))return t("渠道凭据声明无效");
}
export function validatePluginSource(source:CustomSource):string|undefined {
  const error=validatePackage(source.plugin);if(error)return error;
  const m=source.plugin!.manifest;
  if(source.auth!==(m.auth?'bearer':'none')||source.id!==m.id||source.name!==m.name||Object.keys(source.parameters??{}).some(key=>!m.config.some(f=>f.key===key)))return t("渠道身份或配置与 manifest 不一致");
  for(const f of m.config){if(!typedParameter(f,source.parameters&&Object.hasOwn(source.parameters,f.key)?source.parameters[f.key]:f.default))return t("请检查渠道配置：{0}", f.label);}
}
