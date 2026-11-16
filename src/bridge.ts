import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { Menu } from '@tauri-apps/api/menu';
import { nameForLocale } from './branding';
import type { BatchInput, BatchJudgement } from './analysis';
import { emptyState, type AIConfig, type CustomSource, type PluginPackage, type DiskState, type FeedResult, type Judgement, type NewsItem } from './core';
export interface AIUsage {items:number;requests:number;inputChars:number;resetAt:number}
export interface AIPauseState {paused:boolean;enabled?:boolean;startedAt:number;generation:number;requestId?:string}
export const native = isTauri();
let popupMenu: Menu | undefined;
export const previewWindow = { dragRequests: 0, pinned: true, x:0,y:0,width:300,height:34,scale:1,mode:'compact' };
const previewSizes = new Map<string,{width:number;height:number}>();
export type Mode = 'compact' | 'glance' | 'feed' | 'settings';
let demoState = emptyState();
if (!native) {
  demoState.items = Array.from({ length: 16 }, (_, index) => ({
    id: `cls:preview-${index}`, source: 'cls', title: `界面预览 ${index + 1} · 完整消息会在浮窗中从右向左滚动，不再省略关键信息`,
    body: index === 0 ? Array.from({ length: 10 }, (_, i) => `第 ${i + 1} 段预览正文。展开列表保持在最新，有新消息就回到顶部，不会自动向历史滚动；关闭自动展示最新后，可以保留手动阅读位置。`).join('\n') : '这是用于验证布局与滚动的示例，不是实时新闻。横向滚动支持触控板和滚轮；鼠标离开后恢复自动播放。',
    publishedAt: Date.now() - index * 60_000, url: '', tags: [],
  }));
}
const aiOwnedRequests=new Set<string>();let aiRequestSequence=0,aiGeneration=0;
function trackAI(value:AIPauseState){aiGeneration=Math.max(aiGeneration,value.generation);return value;}
export const bridge = {
  ownsAIEvent:(requestId?:string)=>!!requestId&&aiOwnedRequests.delete(requestId),
  load: () => native ? invoke<{ state: DiskState; appName: string; warning?: string; dataPath: string; smoke?: boolean;nativeCompactDrag?:boolean }>('load_state') : Promise.resolve({ state: structuredClone(demoState), appName: nameForLocale(navigator.language), dataPath: '界面预览 · 不读取本机新闻或密钥', warning: undefined, smoke: false,nativeCompactDrag:false }),
  save: (state: DiskState) => native ? invoke<void>('save_state', { state, aiGeneration }) : Promise.resolve(void (demoState = structuredClone(state))),
  inspectPackages:(packages:PluginPackage[])=>native?invoke<void>('inspect_source_packages',{packages}):Promise.resolve(),
  refresh: () => native ? invoke<FeedResult[]>('refresh') : Promise.resolve([]),
  keyStatus: (config: AIConfig) => native ? invoke<boolean>('key_status', { config }) : Promise.resolve(false),
  saveKey: (config: AIConfig, key: string) => native ? invoke<void>('save_key', { config, key }) : Promise.resolve(),
  exportSubscriptions:(content:string)=>native?invoke<string>('export_subscriptions',{content}):Promise.resolve('界面预览：已生成 OPML 文本，可复制保存'),
  saveSourceKey: (source:CustomSource,key:string)=>native?invoke<void>('save_source_key',{source,key}):Promise.resolve(),
  testSource: (source:CustomSource,key?:string)=>native?invoke<FeedResult>('test_source',{source,key}):Promise.reject('当前是界面预览，请在桌面应用中测试接口'),
  testAI: (config:AIConfig,interests:string,item:NewsItem,key?:string)=>native?invoke<Judgement>('test_ai',{config,interests,item,key}):Promise.reject('当前是界面预览，请在桌面应用中测试接口'),
  setAIPaused:(paused:boolean,expectedGeneration?:number)=>{const requestId=String(++aiRequestSequence);aiOwnedRequests.add(requestId);return native?invoke<AIPauseState>('set_ai_paused',{paused,expectedGeneration,requestId}).then(trackAI):Promise.resolve({paused,startedAt:Date.now(),generation:aiRequestSequence,requestId});},
  setAIEnabled:(enabled:boolean,expectedGeneration?:number)=>{const requestId=String(++aiRequestSequence);aiOwnedRequests.add(requestId);return native?invoke<AIPauseState>('set_ai_paused',{paused:!enabled,enabled,expectedGeneration,requestId}).then(trackAI):Promise.resolve({paused:!enabled,enabled,startedAt:Date.now(),generation:aiRequestSequence,requestId});},
  aiUsage:()=>native?invoke<AIUsage>('ai_usage'):Promise.resolve({items:0,requests:0,inputChars:0,resetAt:0}),
  aiEvents:async(pause:(value:AIPauseState)=>void,usage:(value:AIUsage)=>void,configure?:()=>void)=>{if(native){await listen<AIPauseState>('ai-pause-changed',event=>pause(trackAI(event.payload)));await listen<AIUsage>('ai-usage',event=>usage(event.payload));await listen('ai-configure',()=>configure?.());}},
  prepareAIBatch:(inputs:BatchInput[])=>native?invoke<{count:number;chars:number}>('prepare_ai_batch',{inputs}):Promise.resolve({count:inputs.length,chars:inputs.reduce((sum,input)=>sum+input.item.body.length,0)}),
  judgeBatch:(inputs:BatchInput[])=>native?invoke<BatchJudgement[]>('judge_batch',{inputs}):Promise.resolve([]),
  judge: (item: NewsItem, fingerprint: string) => native ? invoke<Judgement | null>('judge', { item, fingerprint }) : Promise.resolve(null),
  presentation: async (mode: Mode, pinned: boolean) => {
    if(native)return invoke<void>('presentation',{mode,pinned});
    previewWindow.mode=mode;
    Object.assign(previewWindow,previewSizes.get(mode)??{width:mode==='compact'?300:mode==='glance'?380:480,height:mode==='compact'?34:mode==='glance'?320:700});
  },
  drag: () => native ? invoke<void>('drag_window') : Promise.resolve(void previewWindow.dragRequests++),
  setPinned: (pinned: boolean) => native ? invoke<void>('set_pin', { pinned }) : Promise.resolve(void (previewWindow.pinned = pinned)),
  windowStatus: () => native?invoke<{x:number;y:number;pinned:boolean;width:number;height:number;scale:number;native?:{level:number;fullScreenAuxiliary:boolean;allSpaces:boolean;allApplications:boolean}}>('window_status'):Promise.resolve({...previewWindow,native:undefined}),
  hovered:()=>native?invoke<boolean>('window_hover'):Promise.resolve(false),
  resize: async (bounds:{x:number;y:number;width:number;height:number;persist:boolean})=>{
    if(native)return invoke<void>('resize_window',{...bounds});
    Object.assign(previewWindow,bounds);
    if(bounds.persist)previewSizes.set(previewWindow.mode,{width:bounds.width,height:bounds.height});
  },
  open: (url: string) => native ? invoke<void>('open_original', { url }) : Promise.resolve(),
  quit: () => native ? invoke<void>('quit') : Promise.resolve(),
  pause: (paused: boolean) => native ? invoke<void>('set_paused', { paused }) : Promise.resolve(),
  popup: async (items: {id:string;text:string;action:()=>void}[]) => {
    if (!native) return;
    await popupMenu?.close();
    popupMenu = await Menu.new({items});
    await popupMenu.popup();
  },
  smokeReport: (report: {horizontal:boolean;glanceScroll:boolean;feedScroll:boolean;collapse:boolean;noOverflow:boolean;pinToggle:boolean;details?:unknown}) => invoke<void>('smoke_report', { report }),
  events: async (feeds: (results: FeedResult[]) => void, presentation: (mode: Mode) => void, issue:(message:string)=>void, hover:(inside:boolean)=>void) => {
    if (native) { await listen<FeedResult[]>('feeds', event => feeds(event.payload)); await listen<Mode>('presentation', event => presentation(event.payload)); await listen<string>('window-error',event=>issue(event.payload)); await listen<boolean>('window-hover',event=>hover(event.payload)); }
  },
};
