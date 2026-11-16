import {allSources,catalogSources} from './feeds';
import type {Preferences,Source} from './core';

export function isInstalled(prefs:Preferences,id:Source):boolean { return allSources(prefs).includes(id); }
export function installChannel(prefs:Preferences,id:Source):void {
  if(!catalogSources(prefs).includes(id))throw new Error('渠道不在目录中，请先导入渠道文件');
  prefs.uninstalledSources=(prefs.uninstalledSources??[]).filter(source=>source!==id);
  prefs.sources=[...new Set([...prefs.sources,id])];
}
export function uninstallChannel(prefs:Preferences,id:Source):void {
  if(!catalogSources(prefs).includes(id))throw new Error('渠道不在目录中');
  prefs.uninstalledSources=[...new Set([...(prefs.uninstalledSources??[]),id])];
  prefs.sources=prefs.sources.filter(source=>source!==id);
}
export function enableChannel(prefs:Preferences,id:Source,enabled:boolean):void {
  if(!isInstalled(prefs,id))throw new Error('请先安装此渠道');
  prefs.sources=enabled?[...new Set([...prefs.sources,id])]:prefs.sources.filter(source=>source!==id);
}
