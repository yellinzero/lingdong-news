import './style.css';
import {nameForLocale} from './branding';
import {BatchPolicy,requestInterval} from './batch-policy';
import {AnalysisClient} from './analysis-client';
import {PlaybackHistory} from './playback';
import {Marquee} from './marquee';
import {previewSubscriptions,exportOPML,exportChannelDirectory,installationCount,maxSources,type ImportPreview} from './subscriptions';
import {channelSource,validatePluginSource} from './source-packages';
import {enableChannel,installChannel,isInstalled,uninstallChannel} from './channels';
import {catalogSources} from './feeds';
import { AnalysisQueue,aiBodyBudget,syncAnalysisPending } from './analysis';
import { bridge, native, previewWindow, type AIUsage, type AIPauseState, type Mode } from './bridge';
import { acknowledge, currentJudgement, deduplicate, emptyState, highlightMode, fingerprint, FollowController, isMatch, keywordMatches, relevanceConfig, merge, parseFeed, sourceNames, sources, validateAdapter, sourceName, allSources, validateSources, validSourceURL, defaultSystemPrompt, syncUnread, text, semanticText, validEndpoint, visibleGroups, type CustomSource, type Judgement, type DiskState, type FeedResult, type NewsGroup, type NewsItem, type Preferences, type Source } from './core';

const icons: Record<string, string> = {
  more:'<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  settings:'<path d="M4 7h16M4 17h16M8 4v6M16 14v6"/>',
  search:'<circle cx="10" cy="10" r="6"/><path d="m15 15 5 5"/>',
  close:'<path d="m6 6 12 12M6 18 18 6"/>', chevronLeft:'<path d="m14 7-5 5 5 5"/>', chevronRight:'<path d="m10 7 5 5-5 5"/>',
  arrow:'<path d="M6 18 18 6M6 6h12v12"/>', follow:'<path d="M12 20V4m-5 5 5-5 5 5"/>', pin:'<path d="M9 3h6l-1 6 4 5H6l4-5zM12 14v7"/>',
};
function icon(name: string): string { return `<svg viewBox="0 0 24 24" aria-hidden="true">${icons[name] ?? icons.arrow}</svg>`; }
function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', content?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag); node.className = className; if (content != null) node.textContent = content; return node;
}
function button(label: string, action: () => void, className = 'icon-button', iconName?: string): HTMLButtonElement {
  const node = el('button', className, iconName ? undefined : label); if (iconName) node.innerHTML = icon(iconName);
  node.type = 'button';
  node.title = label; node.setAttribute('aria-label', label); node.addEventListener('click', action); return node;
}
const root = document.querySelector<HTMLDivElement>('#app')!;
let state: DiskState = emptyState();
let appName = nameForLocale(navigator.language);
let hasKey = false, aiError: string | undefined, storageError: string | undefined, dataPath = '';
let mode: Mode = 'compact', previousMode: Mode = 'feed', paused = false, refreshing = false, judging = false, settingsSaving = false;
let selectedSource: Source | undefined, search = '', groups: NewsGroup[] = [], diagnosticsOpen = false;
let readingToolsOpen = false;
const expandedStories = new Set<string>();
const openStoryDetails = new Set<string>();
const feedStates = new Map<Source, { error?: string; warning?:string; success?: number; count: number }>();
const follow = new FollowController();
let scroller: HTMLElement | null = null, ticker: HTMLElement | null = null, tickerCopy: HTMLElement | null = null, tickerTrack:HTMLElement|null=null, tickerUpcoming:HTMLElement|null=null;
const playback=new PlaybackHistory(()=>state);
let tickerIndex = 0, tickerID = '', tickerPhase: 'start' | 'moving' | 'end' | 'idle' | 'incoming' = 'start', holdUntil = 0;
let autoOffset = 0, lastFrame = 0, lastNewest = '';
let marquee:Marquee|null=null, marqueeDistance=0,tickerOverflows=false,tickerReadDistance=0,tickerRecorded=false;
let tickerCurrent:NewsGroup|undefined,tickerNext:NewsGroup|undefined,tickerPriority:NewsGroup|undefined,tickerOutgoing:HTMLElement|null=null;
const tickerStories=new WeakMap<HTMLElement,NewsGroup>();
let visibleStart=0,visibleCount=40, loadingOlder=false, statusFrame=0;
function scheduleStatus(){if(!statusFrame)statusFrame=requestAnimationFrame(()=>{statusFrame=0;renderStatus();});}
function sameTickerStory(a:NewsGroup|undefined,b:NewsGroup|undefined){
  return !!a&&!!b&&semanticText(a.item)===semanticText(b.item);
}
function tickerSuccessor(){
  if(!groups.length)return;
  if(!state.preferences.skipPlayed)return groups[(tickerIndex+1)%groups.length];
  for(let step=1;step<groups.length;step++){const g=groups[(tickerIndex+step)%groups.length];if(!playback.has(g.item)&&!sameTickerStory(g,tickerCurrent))return g;}
}
function tickerStoryAt(x:number){
  const viewport=ticker?.getBoundingClientRect();
  for(const node of [...(tickerTrack?.querySelectorAll<HTMLElement>('span')??[])].reverse()){
    if(node.hidden)continue;const rect=node.getBoundingClientRect();
    const left=rect.left+Number(node.dataset.clipLeft??0),right=rect.right-Number(node.dataset.clipRight??0);
    if(viewport&&x>=Math.max(left,viewport.left)&&x<=Math.min(right,viewport.right))return tickerStories.get(node)??tickerCurrent;
  }
  return tickerCurrent;
}
function measureTicker(){
  if(!ticker||!tickerCopy||!tickerUpcoming)return;
  const pill=ticker.parentElement!,style=getComputedStyle(pill),baseWidth=pill.clientWidth-parseFloat(style.paddingLeft)-parseFloat(style.paddingRight);
  const range=document.createRange();range.selectNodeContents(tickerCopy);const naturalWidth=range.getBoundingClientRect().width;
  tickerOverflows=naturalWidth>baseWidth+5;tickerReadDistance=Math.max(0,naturalWidth-ticker.clientWidth);
  const tailSpace=parseFloat(getComputedStyle(tickerCopy).paddingRight)||0;
  tickerCopy.style.minWidth=`${baseWidth+tailSpace}px`;
  const distance=tickerOutgoing?tickerOutgoing.getBoundingClientRect().width:tickerUpcoming.hidden?Math.max(0,naturalWidth+tailSpace-ticker.clientWidth):tickerCopy.getBoundingClientRect().width;
  // A narrower viewport or disappearing queue must never move text to the right.
  marqueeDistance=Math.max(distance,marquee?.position()??0);
}
function paintTicker(node:HTMLElement,group:NewsGroup|undefined){
  const body=group?text(group.item).replace(/\s*\n\s*/gu,' '):'';
  if(node.textContent!==body)node.textContent=body;node.title=body;
  node.classList.toggle('matched',!!group?.members.some(i=>isMatch(i,state.preferences,modeInfo().ai)));
  if(group)tickerStories.set(node,group);else tickerStories.delete(node);
}
function prepareTickerNext(){
  if(!tickerUpcoming)return;
  if(tickerPhase==='incoming'){tickerUpcoming.hidden=true;measureTicker();return;}
  const visible=!tickerUpcoming.hidden&&!!ticker&&tickerUpcoming.getBoundingClientRect().left<ticker.getBoundingClientRect().right;
  if(tickerPriority&&(sameTickerStory(tickerPriority,tickerCurrent)||(state.preferences.skipPlayed&&playback.has(tickerPriority.item))))tickerPriority=undefined;
  if(!visible||!tickerNext)tickerNext=tickerPhase==='idle'?undefined:tickerPriority??tickerSuccessor();
  tickerUpcoming.hidden=!tickerNext;paintTicker(tickerUpcoming,tickerNext);measureTicker();
}
function recordTickerPlayback(now:number){
  if(tickerRecorded||!tickerCurrent||tickerPhase!=='moving'||(marquee?.position(now)??0)<tickerReadDistance)return;
  tickerRecorded=true;let changed=false;for(const item of tickerCurrent.members)changed=playback.complete(item)||changed;
  if(changed)void persist();
}
function incomingTicker(group:NewsGroup,now:number){
  if(!ticker||!tickerTrack||!tickerCopy||!tickerUpcoming)return;
  if(tickerPhase==='incoming'){
    // Coalesce frequent arrivals while the incoming headline is still offscreen.
    if(tickerCopy.getBoundingClientRect().left>=ticker.getBoundingClientRect().right){
      tickerCurrent=group;tickerIndex=Math.max(0,groups.findIndex(g=>sameTickerStory(g,group)));tickerID=`${group.id}:${text(group.item)}`;tickerRecorded=false;paintTicker(tickerCopy,group);measureTicker();
    }
    return;
  }
  // Keep every unread suffix. Refreshes can replace only an offscreen successor.
  if(tickerPhase!=='idle'){tickerPriority=group;prepareTickerNext();return;}
  recordTickerPlayback(now);marquee?.pauseVisual(now);
  const viewport=ticker.getBoundingClientRect(),oldClip=tickerOutgoing?.getBoundingClientRect();
  const snapshots=[...tickerTrack.querySelectorAll<HTMLElement>('span')].filter(node=>!node.hidden).map(node=>{
    const rect=node.getBoundingClientRect();let left=Math.max(viewport.left,rect.left+Number(node.dataset.clipLeft??0)),right=rect.right-Number(node.dataset.clipRight??0);
    if(node.classList.contains('ticker-frozen')&&oldClip){left=Math.max(left,oldClip.left);right=Math.min(right,oldClip.right);}
    return {node,rect,left,right,group:tickerStories.get(node)};
  }).filter(s=>s.right>s.left&&s.left<viewport.right&&s.group);
  const outgoing=el('div','ticker-outgoing');outgoing.style.width=`${Math.max(ticker.clientWidth,...snapshots.map(s=>s.right-viewport.left))}px`;
  for(const snapshot of snapshots){
    const node=el('span',`ticker-frozen${snapshot.node.classList.contains('matched')?' matched':''}`,snapshot.node.textContent??'');
    const left=snapshot.left-snapshot.rect.left,right=snapshot.rect.right-snapshot.right;
    node.style.left=`${snapshot.rect.left-viewport.left}px`;node.style.width=`${snapshot.rect.width}px`;node.style.clipPath=`inset(0 ${right}px 0 ${left}px)`;
    node.dataset.clipLeft=String(left);node.dataset.clipRight=String(right);node.setAttribute('aria-hidden','true');node.title=snapshot.node.title;tickerStories.set(node,snapshot.group!);outgoing.append(node);
  }
  tickerOutgoing=outgoing;tickerTrack.replaceChildren(outgoing,tickerCopy,tickerUpcoming);
  tickerCurrent=group;tickerIndex=Math.max(0,groups.findIndex(g=>sameTickerStory(g,group)));tickerID=`${group.id}:${text(group.item)}`;tickerRecorded=false;tickerPhase='incoming';
  paintTicker(tickerCopy,group);marquee?.jump(0);prepareTickerNext();marquee?.play(marqueeDistance,state.preferences.scrollSpeed,now);
}
function finishIncomingTicker(now:number){
  tickerOutgoing?.remove();tickerOutgoing=null;marquee?.jump(0);tickerPhase='moving';prepareTickerNext();
  if(!tickerOverflows){tickerPhase='end';holdUntil=now+4200;}
  const fresh=groups[0];
  if(state.preferences.autoScroll&&fresh&&!sameTickerStory(fresh,tickerCurrent)&&(!state.preferences.skipPlayed||!playback.has(fresh.item)))incomingTicker(fresh,now);
  else if(tickerPhase==='moving')marquee?.play(marqueeDistance,state.preferences.scrollSpeed,now);
}
let hoverPill = false, saveTimer: ReturnType<typeof setTimeout> | undefined;
let pagePauseUntil = 0;
let nativeCompactDrag=false,nativeResizeDrag=false;
let nativeHovered=false,keyboardInput=false;
function updateNativeHover(inside:boolean){
  nativeHovered=inside;
  if(!inside&&!keyboardInput)closeMenus();
  if(mode==='compact'){
    hoverPill=inside;
    root.querySelector('.pill')?.classList.toggle('is-hovered',inside);
    if(!inside)pagePauseUntil=0;
  }
}
let statusButton: HTMLButtonElement | null = null, followButton: HTMLButtonElement | null = null;
let diagnostics: HTMLElement | null = null, list: HTMLElement | null = null;
const rowNodes = new Map<string, { key: string; node: HTMLElement }>();

let aiBatchError:string|undefined;
let aiUsage:AIUsage={items:0,requests:0,inputChars:0,resetAt:0},quotaBlocked=false,aiControlRevision=0,aiEventGeneration=0;
let settingsDraft:Preferences|undefined,attentionTimer:ReturnType<typeof setTimeout>|undefined;
const analysisClient=new AnalysisClient(()=>state,()=>{updateView();void persist(true);});
const batchPolicy=new BatchPolicy();
const analysisQueue=new AnalysisQueue({
  coalesceMs:jobs=>batchPolicy.waitMs(state.preferences.aiLimits,state.preferences.ai.batchSize,jobs.length,aiBodyBudget(state)),
  prepare:inputs=>bridge.prepareAIBatch(inputs),
  jobs:async()=>{const jobs=await analysisClient.plan(hasKey);batchPolicy.observe(jobs);return jobs;},enabled:()=>!paused&&!settingsSaving&&!state.preferences.aiPaused&&!quotaBlocked&&modeInfo().ai,
  minIntervalMs:()=>requestInterval(state.preferences.aiLimits),
  batchSize:()=>state.preferences.ai.batchSize,concurrency:()=>state.preferences.ai.concurrency,
  maxRetries:()=>state.preferences.aiLimits.maxRetries,maxChars:()=>aiBodyBudget(state),
  dispatch:inputs=>bridge.judgeBatch(inputs),apply:()=>{},
  applyBatch:results=>analysisClient.apply(results,hasKey),
  changed:()=>{judging=analysisQueue.active;renderStatus();},
  error:message=>{aiBatchError=message;if(/Key 无效|无权限|余额不足|HTTP [34]|重定向|凭据/u.test(message))void controlAI(true);if(message.startsWith('AI_LIMIT')||message.startsWith('AI_INPUT_LIMIT')||/用量记录|保存 AI 用量/u.test(message)){quotaBlocked=true;analysisQueue.stop();}renderStatus();},
});
function scheduleAttention(){clearTimeout(attentionTimer);attentionTimer=setTimeout(()=>{void analysisClient.sync(hasKey).catch(error=>{aiBatchError=String(error);renderStatus();});},120);}
function receiveAIPause(value:AIPauseState){
  const owned=bridge.ownsAIEvent(value.requestId);
  if(value.generation<aiEventGeneration)return;aiEventGeneration=value.generation;
  state.preferences.aiPaused=value.paused;state.preferences.aiStartedAt=value.startedAt;
  if(value.enabled!==undefined){state.preferences.aiEnabled=value.enabled;if(settingsDraft)settingsDraft.aiEnabled=value.enabled;}
  if(settingsDraft){settingsDraft.aiPaused=value.paused;settingsDraft.aiStartedAt=value.startedAt;}
  if(value.paused){if(!owned)aiControlRevision++;analysisQueue.stop();analysisClient.invalidate();}else void screenNews();renderStatus();
}
async function controlAI(stop:boolean){
  const revision=++aiControlRevision;state.preferences.aiPaused=stop;
  if(settingsDraft)settingsDraft.aiPaused=stop;
  analysisQueue.stop();analysisClient.invalidate();renderStatus();
  try{
    const result=await bridge.setAIPaused(stop);if(revision!==aiControlRevision)return;
    state.preferences.aiPaused=result.paused;state.preferences.aiStartedAt=result.startedAt;if(settingsDraft){settingsDraft.aiPaused=result.paused;settingsDraft.aiStartedAt=result.startedAt;}
    if(!stop){hasKey=validEndpoint(state.preferences.ai)?await bridge.keyStatus(state.preferences.ai).catch(()=>false):false;if(revision!==aiControlRevision)return;aiBatchError=undefined;quotaBlocked=false;aiUsage=await bridge.aiUsage();syncAnalysisPending(state);analysisQueue.retry();}
    void persist();renderStatus();
  }catch(error){state.preferences.aiPaused=true;if(settingsDraft)settingsDraft.aiPaused=true;notifyError(error);}
}
async function openAISettings(){
  if(mode!=='settings')await setMode('settings');
  const section=root.querySelector<HTMLElement>('.ai-settings');
  const details=section?.querySelector<HTMLDetailsElement>('details');if(details)details.open=true;
  section?.scrollIntoView({block:'start'});
}
let aiStarting=false;
async function disableAI(){
  ++aiControlRevision;aiStarting=false;state.preferences.aiEnabled=false;state.preferences.aiPaused=true;
  if(settingsDraft){settingsDraft.aiEnabled=false;settingsDraft.aiPaused=true;}
  analysisQueue.stop();analysisClient.invalidate();updateView();
  try{await bridge.setAIEnabled(false);await persist(true,true);}catch(error){notifyError(error);}
}
async function enableAI(){
  if(aiStarting||(state.preferences.aiEnabled&&!state.preferences.aiPaused))return;
  if(!validEndpoint(state.preferences.ai)||!state.preferences.interests.trim()){await openAISettings();return;}
  const revision=++aiControlRevision;aiStarting=true;renderStatus();
  try{
    const pause=await bridge.setAIPaused(true);
    let ready=false;
    try{ready=await bridge.keyStatus(state.preferences.ai);}catch(error){if(revision===aiControlRevision){hasKey=false;await openAISettings();notifyError(error);}return;}
    if(revision!==aiControlRevision)return;
    hasKey=ready;
    if(!ready){await openAISettings();return;}
    const result=await bridge.setAIEnabled(true,pause.generation);
    if(revision!==aiControlRevision)return;
    state.preferences.aiEnabled=true;state.preferences.aiPaused=result.paused;state.preferences.aiStartedAt=result.startedAt;
    if(settingsDraft){settingsDraft.aiEnabled=true;settingsDraft.aiPaused=result.paused;settingsDraft.aiStartedAt=result.startedAt;}
    aiError=undefined;aiBatchError=undefined;quotaBlocked=false;aiUsage=await bridge.aiUsage();
    if(revision!==aiControlRevision)return;
    await persist(true,true);syncAnalysisPending(state);analysisQueue.retry();updateView();void screenNews();
  }catch(error){if(revision===aiControlRevision){state.preferences.aiPaused=true;notifyError(error);}}
  finally{if(revision===aiControlRevision)aiStarting=false;renderStatus();}
}
function retryAI(){void controlAI(false);}
function applyAppearance(prefs=state.preferences){
  document.documentElement.dataset.theme=prefs.theme==='system'?(matchMedia('(prefers-color-scheme: light)').matches?'light':'dark'):prefs.theme;
  document.documentElement.dataset.accent=prefs.accent;
}
matchMedia('(prefers-color-scheme: light)').addEventListener('change',()=>applyAppearance(settingsDraft??state.preferences));
function aiAccount(prefs:Preferences){try{return new URL(prefs.ai.apiUrl).origin;}catch{return '';}}
function modeInfo() { return highlightMode(state.preferences, hasKey||state.preferences.aiPaused, aiError); }
function issues(): string[] { return [...allSources(state.preferences).filter(s => state.preferences.sources.includes(s)).flatMap(s => feedStates.get(s)?.error ? [`${sourceName(s,state.preferences)}：${feedStates.get(s)!.error}`] : []), ...((aiError||aiBatchError) ? [`AI：${aiError||aiBatchError}`] : []), ...(storageError ? [storageError] : [])]; }
function notifyError(error: unknown) { storageError = typeof error === 'string' ? error : '操作未完成，请稍后重试'; renderStatus(); }
let savingState:Promise<void>=Promise.resolve();
async function persist(immediate = false, strict = false): Promise<void> {
  clearTimeout(saveTimer);
  if (!immediate) { saveTimer = setTimeout(() => { void persist(true); }, 250); return; }
  const save=savingState.catch(()=>{}).then(()=>bridge.save(state));savingState=save;
  try { await save; } catch (error) { notifyError(error); if(strict)throw error; }
}
async function setMode(next: Mode, fromNative = false): Promise<void> {
  if (next === 'settings' && mode !== 'settings') previousMode = mode;
  closeMenus();
  if(mode==='settings'&&next!=='settings'){settingsDraft=undefined;applyAppearance();}
  const presentation=fromNative?Promise.resolve():bridge.presentation(next,state.preferences.pinned);
  mode = next; follow.hovering = false; hoverPill = false;visibleStart=0;visibleCount=40;
  if (next !== 'settings') follow.resume();
  renderShell();
  try { await presentation; } catch (error) { notifyError(error); }
}
function wireDrag(node: HTMLElement) {
  node.classList.add('window-drag-region');
  node.title = '按住此处拖动窗口';
  node.addEventListener('mousedown', event => {
    if (event.button !== 0 || (event.target as Element).closest('button,input,textarea,select,a,summary')) return;
    // Keep the original native mouse-down event available to WKWebView/AppKit.
    event.stopPropagation();
    void bridge.drag().catch(notifyError);
  });
}
function wireCompactDrag(node: HTMLElement) {
  node.classList.add('compact-drag-region'); node.title = '拖动可移动；单击查看快讯；左右方向键翻页';
  let start: {x:number;y:number;clientX:number;clientY:number;id:number} | undefined, dragged = false;
  node.addEventListener('pointerdown', event => {
    if (event.button !== 0 || (event.target as Element).closest('button,.resize-handle')) return;
    start = {x:event.screenX,y:event.screenY,clientX:event.clientX,clientY:event.clientY,id:event.pointerId}; dragged = false;
    node.setPointerCapture(event.pointerId);
  });
  node.addEventListener('pointermove', event => {
    if (!start || dragged || Math.max(Math.hypot(event.screenX-start.x,event.screenY-start.y),Math.hypot(event.clientX-start.clientX,event.clientY-start.clientY))<4) return;
    dragged = true; node.classList.add('is-dragging');
    if (node.hasPointerCapture(start.id)) node.releasePointerCapture(start.id);
    if(!nativeCompactDrag)void bridge.drag().catch(notifyError);
  });
  node.addEventListener('pointerup', () => { start=undefined; node.classList.remove('is-dragging'); });
  node.addEventListener('pointercancel', () => { start=undefined; node.classList.remove('is-dragging'); });
  node.addEventListener('click', event => {
    if (dragged && !(event.target as Element).closest('button')) { event.preventDefault(); event.stopImmediatePropagation(); dragged=false; }
  }, true);
}
function addResizeHandles(parent: HTMLElement, compact: boolean) {
  for (const edge of compact ? ['w','e'] : ['w','e','n','s','nw','ne','sw','se']) {
    const handle=el('div',`resize-handle resize-${edge}`); handle.dataset.edge=edge; handle.title=compact?'拖动调整宽度':'拖动调整窗口大小';
    handle.addEventListener('pointerdown', event => {
      if(event.button!==0)return; event.preventDefault(); event.stopPropagation();
      // Let the compositor resize native Windows/Linux windows, including Wayland.
      if(nativeResizeDrag){void bridge.resizeDrag(edge).catch(notifyError);return;}
      const start={x:event.screenX,y:event.screenY,clientX:event.clientX,clientY:event.clientY}; handle.setPointerCapture(event.pointerId);
      let orientationX=0,orientationY=0;
      const delta=(e:PointerEvent)=>{
        if(!native)return {x:e.clientX-start.clientX,y:e.clientY-start.clientY};
        const x=e.screenX-start.x,y=e.screenY-start.y;
        // WKWebView versions can expose bottom-origin screenY on macOS. Infer
        // orientation from the first move, before changing the window frame.
        if(!orientationX&&Math.abs(x)>1&&Math.abs(e.clientX-start.clientX)>1)orientationX=Math.sign(x)*Math.sign(e.clientX-start.clientX);
        if(!orientationY&&Math.abs(y)>1&&Math.abs(e.clientY-start.clientY)>1)orientationY=Math.sign(y)*Math.sign(e.clientY-start.clientY);
        return {x:x*(orientationX||1),y:y*(orientationY||1)};
      };
      let latest={x:0,y:0}, scheduled=false, finished=false;
      const bounds=bridge.windowStatus();
      const apply=async(persist:boolean)=>{
        const b=await bounds,dx=latest.x,dy=latest.y;
        const west=edge.includes('w'),north=edge.includes('n');
        const width=Math.max(compact?180:320,b.width+(west?-dx:edge.includes('e')?dx:0));
        const height=compact?34:Math.max(220,b.height+(north?-dy:edge.includes('s')?dy:0));
        await bridge.resize({x:b.x/b.scale+(west?b.width-width:0),y:b.y/b.scale+(north?b.height-height:0),width,height,persist});
      };
      const move=(e:PointerEvent)=>{latest=delta(e);if(!scheduled){scheduled=true;requestAnimationFrame(()=>{scheduled=false;if(!finished)void apply(false).catch(notifyError);});}};
      const end=(e:PointerEvent)=>{finished=true;latest=delta(e);handle.removeEventListener('pointermove',move);handle.removeEventListener('pointerup',end);handle.removeEventListener('pointercancel',end);void apply(true).catch(notifyError);};
      handle.addEventListener('pointermove',move);handle.addEventListener('pointerup',end);handle.addEventListener('pointercancel',end);
    });
    parent.append(handle);
  }
}
async function setPinned(pinned: boolean) {
  try {
    await bridge.setPinned(pinned);
    state.preferences.pinned = pinned;
    renderPin();
    await persist(true);
  } catch (error) { notifyError(error); }
}
function renderPin() {
  const pin = root.querySelector<HTMLButtonElement>('[data-pin-toggle]');
  if (!pin) return;
  const pinned = state.preferences.pinned;
  pin.classList.toggle('is-pinned', pinned);
  pin.setAttribute('aria-pressed', String(pinned));
  pin.title = pinned ? '已置顶 · 点击取消置顶' : '未置顶 · 点击置顶';
  pin.setAttribute('aria-label', pin.title);
}
function closeMenus() { document.querySelector('.context-menu')?.remove(); root.querySelectorAll<HTMLDetailsElement>('.reader-menu[open]').forEach(menu => { menu.open = false; }); }
function wireMenu(menu:HTMLDetailsElement){
 let timer:ReturnType<typeof setTimeout>|undefined;
 menu.addEventListener('pointerleave',()=>{clearTimeout(timer);if(menu.open)timer=setTimeout(()=>{menu.open=false;},180);});
 menu.addEventListener('pointerdown',()=>clearTimeout(timer));
 menu.addEventListener('toggle',()=>clearTimeout(timer));
 menu.addEventListener('pointerenter',()=>clearTimeout(timer));
 menu.addEventListener('focusout',event=>{if(event.relatedTarget&&!menu.contains(event.relatedTarget as Node))menu.open=false;});
}
async function openLatest(){search='';selectedSource=undefined;readingToolsOpen=false;await setMode('glance');resumeFollow();}
function aiMenuLabel(){return aiStarting?'取消开启 AI':!state.preferences.aiEnabled?'开启 AI':state.preferences.aiPaused?'AI 已暂停 · 关闭':'关闭 AI';}
function aiMenuAction(){if(state.preferences.aiEnabled||aiStarting)void disableAI();else void enableAI();}
function contextMenu(event: MouseEvent) {
  event.preventDefault(); closeMenus();
  const selected=tickerStoryAt(event.clientX);
  if (native) {
    void bridge.popup([
      {id:'story',text:'展开这条新闻',action:()=>void openCurrentStory(selected)},
      {id:'glance',text:'查看最新快讯',action:()=>void openLatest()},
      {id:'settings',text:'设置',action:()=>void setMode('settings')},
      {id:'ai',text:aiMenuLabel(),action:aiMenuAction},
      {id:'pause',text:paused?'继续更新':'暂停更新',action:togglePause},
      {id:'quit',text:'退出',action:()=>void bridge.quit()},
    ]).catch(notifyError);
    return;
  }
  const menu = el('div', 'context-menu');
  menu.append(button('展开这条新闻', () => { closeMenus();void openCurrentStory(selected); }, ''),button('查看最新快讯', () => { closeMenus(); void openLatest(); }, ''), button('设置', () => { closeMenus(); void setMode('settings'); }, ''), button(paused ? '继续更新' : '暂停更新', () => { closeMenus(); togglePause(); }, ''), button('退出', () => void bridge.quit(), ''));
  menu.append(button(aiMenuLabel(),()=>{closeMenus();aiMenuAction();},''));
  root.append(menu);
  menu.style.left = `${Math.min(event.clientX, Math.max(4, innerWidth - 130))}px`; menu.style.top = `${Math.min(event.clientY, Math.max(4, innerHeight - 180))}px`;
}
document.addEventListener('mousedown', event => { if (!(event.target as Element).closest('.context-menu,.reader-menu')) closeMenus(); });
document.addEventListener('keydown', event => {
  keyboardInput=true;
  if(event.key==='Tab'||event.key.startsWith('Arrow'))root.querySelector('.pill')?.classList.add('keyboard-focus');
  if((event.metaKey||event.ctrlKey)&&event.shiftKey&&event.key.toLowerCase()==='k'){event.preventDefault();void disableAI();return;}
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f' && mode !== 'compact' && mode !== 'settings') {
    event.preventDefault();
    readingToolsOpen = true;
    void (mode === 'feed' ? Promise.resolve() : setMode('feed')).then(() => { const tools = root.querySelector<HTMLDetailsElement>('.reading-tools'); if (tools) tools.open = true; root.querySelector<HTMLInputElement>('.search-input')?.focus(); });
    return;
  }
  if (event.key === 'Escape' && root.querySelector('.reader-menu[open]')) { event.preventDefault(); closeMenus(); root.querySelector<HTMLElement>('.reader-menu > summary')?.focus(); return; }
  if (event.key === 'Escape' || ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'w')) { event.preventDefault(); void setMode('compact'); }
});
document.addEventListener('pointerdown',()=>{keyboardInput=false;root.querySelector('.pill')?.classList.remove('keyboard-focus');});
document.addEventListener('pointermove',()=>{keyboardInput=false;root.querySelector('.pill')?.classList.remove('keyboard-focus');},{passive:true});
document.addEventListener('focusout',event=>{if(!(event.relatedTarget as Element|null)?.closest('.pill'))root.querySelector('.pill')?.classList.remove('keyboard-focus');});
window.addEventListener('blur',()=>{closeMenus();updateNativeHover(false);root.querySelector('.pill')?.classList.remove('keyboard-focus');});
document.addEventListener('selectionchange', () => { follow.selection = !!window.getSelection()?.toString(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden && !paused) void refresh(); });
window.addEventListener('online', () => { if (!paused) void refresh(); });

function renderShell() {
  marquee?.dispose();marquee=null;tickerCurrent=tickerNext=tickerPriority=undefined;tickerOutgoing=null;
  root.replaceChildren(); rowNodes.clear(); scroller = ticker = tickerCopy = tickerTrack = tickerUpcoming = list = diagnostics = null;
  followButton = statusButton = null;
  lastFrame = 0; autoOffset = 0; pagePauseUntil=0;
  if (mode === 'compact') {
    const pill = el('div', 'pill'); pill.classList.toggle('is-hovered',nativeHovered);hoverPill=nativeHovered;pill.addEventListener('contextmenu', contextMenu);
    wireCompactDrag(pill);
    ticker = el('div', 'ticker'); ticker.role = 'button'; ticker.tabIndex = 0; ticker.setAttribute('aria-label', '展开快讯');
    tickerTrack=el('div','ticker-track');tickerCopy = el('span', 'ticker-copy');tickerUpcoming=el('span','ticker-upcoming');tickerUpcoming.setAttribute('aria-hidden','true');tickerTrack.append(tickerCopy,tickerUpcoming);ticker.append(tickerTrack);marquee=new Marquee(tickerTrack);
    pill.addEventListener('click', event => {
      if((event.target as Element).closest('button,.resize-handle'))return;
      // Protect the pager hit area even if an inactive WebView has not yet
      // painted its hover state; first clicks there must never expand.
      const rect=pill.getBoundingClientRect(),x=event.clientX-rect.left;
      if(x>=rect.width-56){manualPage(x<rect.width-30?-1:1);return;}
      void openCurrentStory(tickerStoryAt(event.clientX));
    });
    pill.addEventListener('keydown', event => {
      if (!(event.target as Element).closest('button')&&(event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); void openCurrentStory(); }
      if (event.key === 'ArrowRight') { event.preventDefault(); manualNext(); }
      if (event.key === 'ArrowLeft') { event.preventDefault(); manualPage(-1); }
    });
    ticker.addEventListener('wheel', event => {
      event.preventDefault(); follow.manual(performance.now());
      const delta=Math.abs(event.deltaX)>Math.abs(event.deltaY)?event.deltaX:event.deltaY;
      marquee?.jump(Math.max(0,Math.min(marqueeDistance,(marquee?.position()??0)+delta)));if(tickerPhase!=='incoming')tickerPhase='moving';
    }, { passive: false });
    pill.addEventListener('mouseenter', () => { hoverPill = true; pill.classList.add('is-hovered');measureTicker(); });
    pill.addEventListener('mouseleave', () => { hoverPill = false; pagePauseUntil=0; pill.classList.remove('is-hovered');measureTicker(); });
    const previous = button('上一条', () => manualPage(-1), 'ticker-previous', 'chevronLeft');
    const next = button('下一条', manualNext, 'ticker-next', 'chevronRight');
    pill.append(ticker, previous, next); addResizeHandles(pill,true); root.append(pill); tickerID = ''; tickerIndex = 0; updateView(); return;
  }
  const panel = el('section', `panel ${mode}`);
  const header = el('header', 'panel-header'); wireDrag(header);
  header.append(el('span', 'brand', mode === 'settings' ? '设置' : appName));
  if (!native) header.append(el('span', 'preview-tag', '预览'));
  header.append(el('span', 'spacer'));
  if (mode !== 'settings') {
    const pin = button('窗口置顶', () => void setPinned(!state.preferences.pinned), 'icon-button pin-toggle', 'pin'); pin.dataset.pinToggle = '';
    const menu = el('details', 'reader-menu');
    const trigger = el('summary', 'icon-button'); trigger.innerHTML = icon('more'); trigger.title = '更多'; trigger.setAttribute('aria-label', '更多');
    const actions = el('div', 'reader-menu-actions');
    const refreshButton = button('立即刷新', () => { closeMenus(); void refresh(); }, 'refresh-control');
    actions.append(refreshButton, button(paused ? '继续更新' : '暂停更新', () => { closeMenus(); togglePause(); }, 'update-toggle'));
    wireMenu(menu);menu.append(trigger, actions);
    header.append(pin, menu, button('设置', () => void setMode('settings'), 'icon-button', 'settings'));
  }
  const aiControl=button(aiMenuLabel(),aiMenuAction,'ai-control');aiControl.dataset.aiControl='';header.append(aiControl);
  header.append(button('收起', () => void setMode('compact'), 'collapse')); panel.append(header);
  if (mode === 'settings') { renderSettings(panel); addResizeHandles(panel,false); root.append(panel);renderStatus(); return; }
  if (mode === 'feed'||mode==='glance') {
    const tools = el('details', 'reading-tools'); tools.open = readingToolsOpen || !!search || !!selectedSource;
    const summary = el('summary', 'reading-tools-summary'); summary.innerHTML = icon('search'); summary.append(el('span', 'reading-tools-label', '搜索与来源'));
    tools.append(summary); tools.addEventListener('toggle', () => { readingToolsOpen = tools.open; });
    const controls = el('div', 'controls'), chips = el('div', 'source-chips');
    chips.setAttribute('role', 'group'); chips.setAttribute('aria-label', '筛选消息来源');
    for (const source of [undefined, ...state.preferences.sources]) {
      const chip = button(source ? sourceName(source,state.preferences) : '全部', () => {
        selectedSource = source;visibleStart=0; visibleCount=40;follow.resume(); updateView();
        chips.querySelectorAll('button').forEach(node => { node.classList.toggle('active', node === chip); node.setAttribute('aria-pressed', String(node === chip)); });
        if (scroller) scroller.scrollTop = 0;
      }, `chip ${selectedSource === source ? 'active' : ''}`); chip.setAttribute('aria-pressed', String(selectedSource === source)); chips.append(chip);
    }
    const searchWrap = el('div', 'search-wrap'); searchWrap.innerHTML = icon('search');
    const input = el('input', 'search-input'); input.type = 'search'; input.placeholder = '搜索快讯'; input.setAttribute('aria-label', '搜索快讯'); input.value = search; input.autocomplete = 'off'; input.spellcheck = false;
    input.addEventListener('input', () => applySearch(input.value));
    const clear = button('清除搜索', () => { applySearch(''); input.focus(); }, 'search-clear', 'close'); clear.hidden = !search;
    searchWrap.append(input, clear, el('span', 'filter-label', modeInfo().label)); controls.append(searchWrap, chips); tools.append(controls); panel.append(tools);
  }
  scroller = el('div', 'news-scroll'); scroller.tabIndex = 0; scroller.setAttribute('aria-label', '完整快讯列表');
  list = el('div', 'news-list'); scroller.append(list);
  const manual = () => { follow.manual(performance.now()); autoOffset = scroller!.scrollTop; scheduleStatus(); };
  scroller.addEventListener('wheel', manual, { passive: true }); scroller.addEventListener('touchstart', manual, { passive: true });
  scroller.addEventListener('pointerdown', manual);
  scroller.addEventListener('keydown', event => { if (['ArrowUp','ArrowDown','PageUp','PageDown','Home','End',' '].includes(event.key)) manual(); });
  // Native scrollbar dragging also counts as browsing. Programmatic moves are tracked separately.
  scroller.addEventListener('scroll', () => { if (Math.abs(scroller!.scrollTop - autoOffset) > 3) { follow.manual(performance.now()); autoOffset = scroller!.scrollTop; } scheduleStatus();if(scroller!.scrollTop+scroller!.clientHeight>scroller!.scrollHeight-600)loadOlder(); }, { passive: true });
  panel.append(scroller);
  diagnostics = el('div', 'diagnostics'); diagnostics.id = 'connection-details'; diagnostics.hidden = !diagnosticsOpen; panel.append(diagnostics);
  const footer = el('footer', 'footer');
  followButton = button('回到最新', resumeFollow, 'follow-button');
  statusButton = button('连接详情', () => { diagnosticsOpen = !diagnosticsOpen; renderStatus(); }, 'status-button');
  statusButton.setAttribute('aria-controls', 'connection-details');
  footer.append(followButton, el('span', 'spacer'), statusButton);

  panel.append(footer); addResizeHandles(panel,false); root.append(panel); updateView();
}
function applySearch(value: string) {
  search = value;visibleStart=0;visibleCount=40;
  const input = root.querySelector<HTMLInputElement>('.search-input'); if (input) input.value = value;
  const clear = root.querySelector<HTMLButtonElement>('.search-clear'); if (clear) clear.hidden = !value;
  follow.resume(); updateView();
  if (scroller) { scroller.scrollTop = 0; autoOffset = 0; }
}
function resumeFollow() {
  window.getSelection()?.removeAllRanges(); follow.resume();
  if(visibleStart>0){visibleStart=0;visibleCount=40;updateView();}
  if (scroller) { scroller.scrollTop = 0; autoOffset = 0; }
  renderStatus();
}
function formatTime(value: number): string { return new Date(value).toLocaleTimeString('zh-CN', { hour12: false }); }
function row(group: NewsGroup): HTMLElement {
  const mode = modeInfo(), matches = group.members.flatMap(i => keywordMatches(i, state.preferences));
  const judgement = group.members.map(i => currentJudgement(i, state.preferences)).filter((j): j is Judgement => !!j && (j.kind === 'json' ? j.relevant === true : j.probability >= state.preferences.threshold)).sort((a,b) => b.probability-a.probability)[0];
  const matched = group.members.some(i => isMatch(i, state.preferences, mode.ai));
  const article = el('article', `news-row ${matched ? 'matched' : ''}`); article.dataset.id = group.id;
  const meta = el('div', 'row-meta');
  const latestItem = group.members.find(item => item.publishedAt === group.latestDate) ?? group.item;
  const time = el('time', 'row-time', formatTime(group.latestDate));
  time.dateTime = new Date(group.latestDate).toISOString();
  time.title = `${latestItem.dateEstimated ? '首次获取时间（来源未提供发布时间）' : '发布时间'} · ${new Date(group.latestDate).toLocaleString('zh-CN')}`;
  meta.append(time, el('span', 'row-source', [...new Set(group.members.map(i => i.source))].map(s => sourceName(s,state.preferences)).join(' · ')));
  if (latestItem.dateEstimated) meta.append(el('span', 'estimated-time', '首次获取'));
  if (new Date(group.latestDate).toDateString() !== new Date().toDateString()) meta.append(el('span', '', new Date(group.latestDate).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })));
  if (matches.length) meta.append(el('span', 'badge', [...new Set(matches)].slice(0, 2).join(' · ')));
  if (judgement) { const badge=el('span','badge ai-match',judgement.kind === 'json' ? 'AI 关注' : `JEV ${Math.round(judgement.probability*100)}%`); badge.title=judgement.reason || 'JEV 判断的相关概率，表示与关注条件的匹配程度'; meta.append(badge); }
  if (mode.active && group.members.some(i => state.unread.some(u => u.id === i.id))) meta.append(button('标为已读', () => { acknowledge(state, group); void persist(); updateView(); }, 'read-button'));
  if (group.item.url) meta.append(button('打开原文', () => void bridge.open(group.item.url).catch(notifyError), 'row-open', 'arrow'));
  const body = el('p', 'news-body'); body.id = `story-${encodeURIComponent(group.id)}`;
  const fullText = text(group.item);
  // Emphasize only a headline actually supplied by the source; never invent a summary.
  const headline = group.item.title && fullText.startsWith(group.item.title) ? group.item.title : /^【[^】]+】/u.exec(fullText)?.[0];
  if (headline && fullText.length > headline.length) body.append(el('strong', 'news-headline', headline), document.createTextNode(fullText.slice(headline.length)));
  else body.textContent = fullText;
  const toggle = button('展开全文', () => {
    if (expandedStories.has(group.id)) expandedStories.delete(group.id); else expandedStories.add(group.id);
    updateStoryPreview(article);
    // Collapsing a long item keeps its preview in reach instead of stranding the viewport below it.
    if (!expandedStories.has(group.id) && scroller && article.offsetTop < scroller.scrollTop) { scroller.scrollTop = article.offsetTop; autoOffset = scroller.scrollTop; }
  }, 'story-toggle');
  toggle.setAttribute('aria-controls', body.id);
  article.append(meta, body, toggle);
  const tags=[...new Set(group.members.flatMap(i=>i.tags??[]))];
  if(tags.length){const line=el('div','news-tags');line.setAttribute('aria-label','新闻标签');for(const tag of tags){const chip=el('span','source-tag',tag);chip.title='来源提供的新闻标签';line.append(chip);}article.append(line);}
  if (group.members.length > 1 || judgement?.reason || judgement?.tags?.length) {
    const detail = el('details', 'story-details'); detail.open = openStoryDetails.has(group.id);
    const label = [group.members.length > 1 ? `${group.members.length} 条合并原文` : '', judgement ? '关注依据' : ''].filter(Boolean).join(' · ');
    detail.append(el('summary', '', label));
    detail.addEventListener('toggle', () => { if (detail.open) openStoryDetails.add(group.id); else openStoryDetails.delete(group.id); });
    if(judgement?.reason) detail.append(el('p', 'ai-reason', judgement.reason));
    if(judgement?.tags?.length){const line=el('div','news-tags ai-tags');line.setAttribute('aria-label','AI 标签');for(const tag of judgement.tags)line.append(el('span','source-tag',`AI · ${tag}`));detail.append(line);}
    if (group.members.length > 1) for (const item of group.members) {
      const origin = el('div', 'related');
      const attribution = `${sourceName(item.source,state.preferences)} · ${new Date(item.publishedAt).toLocaleString('zh-CN')}${item.dateEstimated ? '（首次获取）' : ''}`;
      origin.append(item.url ? button(attribution, () => void bridge.open(item.url).catch(notifyError), '') : el('span', '', attribution), el('p', '', text(item)));
      detail.append(origin);
    }
    article.append(detail);
  }
  return article;
}
function prepareStory(article:HTMLElement){
  const body=article.querySelector<HTMLElement>('.news-body')!, toggle=article.querySelector<HTMLButtonElement>('.story-toggle')!;
  const expanded=expandedStories.has(article.dataset.id!);article.classList.toggle('story-expanded',expanded);
  const focused=document.activeElement===toggle;
  if(expanded&&toggle.nextSibling!==body)article.insertBefore(toggle,body);
  else if(!expanded&&body.nextSibling!==toggle)body.after(toggle);
  if(focused&&document.activeElement!==toggle)toggle.focus({preventScroll:true});
  return {body,toggle,expanded};
}
function previewControl({toggle,expanded}:ReturnType<typeof prepareStory>,overflow:boolean){
  if(toggle.hidden===overflow)toggle.hidden=!overflow;
  const label=expanded?'收起全文':'展开全文';
  if(toggle.textContent!==label){toggle.textContent=label;toggle.title=label;toggle.setAttribute('aria-label',label);}
  toggle.setAttribute('aria-expanded',String(expanded));
}
function updateStoryPreview(article:HTMLElement){const prepared=prepareStory(article);previewControl(prepared,prepared.body.scrollHeight>Number.parseFloat(getComputedStyle(prepared.body).lineHeight)*3+2);}
function updatePreviews(){
  const rows=[...rowNodes.values()].map(({node})=>prepareStory(node));
  const overflow=rows.map(({body})=>body.scrollHeight>Number.parseFloat(getComputedStyle(body).lineHeight)*3+2);
  rows.forEach((row,index)=>previewControl(row,overflow[index]));
}
let previewResizeFrame=0,previewResizeTimer:ReturnType<typeof setTimeout>|undefined;
function flushPreviews(){cancelAnimationFrame(previewResizeFrame);previewResizeFrame=0;clearTimeout(previewResizeTimer);measureTicker();updatePreviews();}
new ResizeObserver(()=>{
  if(previewResizeFrame)return;
  previewResizeFrame=requestAnimationFrame(flushPreviews);
  // Accessory WebViews may throttle rAF while resizing without activation.
  previewResizeTimer=setTimeout(flushPreviews,40);
}).observe(root);
// A real resize must not wait for an accessory WebView's next animation frame.
window.addEventListener('resize',flushPreviews);
function loadOlder(){
  if(loadingOlder||visibleStart+visibleCount>=groups.length||!list)return;
  loadingOlder=true;requestAnimationFrame(()=>{loadingOlder=false;if(list){visibleCount+=40;updateView();}});
}
function updateView() {
  groups = visibleGroups(state, hasKey||state.preferences.aiPaused, aiError, mode==='compact'?undefined:selectedSource,mode==='compact'?'':search);
  const latest = groups[0];
  const newest = latest ? JSON.stringify([latest.id, latest.latestDate, text(latest.item)]) : '';
  const now = performance.now();
  follow.auto = state.preferences.autoScroll;
  follow.hovering = mode === 'compact' && hoverPill;
  if (ticker && tickerCopy) {
    const current=groups.findIndex(g=>sameTickerStory(g,tickerCurrent));
    const changed=newest!==lastNewest;
    const pending=state.preferences.skipPlayed?groups.findIndex(g=>!playback.has(g.item)):groups.length?0:-1;
    if(current>=0)tickerIndex=current;
    if(!tickerCurrent){
      tickerIndex=Math.max(0,pending);tickerID='';updateTicker(now);
      if(state.preferences.skipPlayed&&pending<0&&groups.length){tickerPhase='idle';prepareTickerNext();}
    }else if(changed&&state.preferences.autoScroll&&latest&&!sameTickerStory(latest,tickerCurrent)&&(!state.preferences.skipPlayed||!playback.has(latest.item))){
      incomingTicker(latest,now);
    }else if((current<0||tickerPhase==='idle')&&pending>=0&&!sameTickerStory(groups[pending],tickerCurrent)){
      incomingTicker(groups[pending],now);
    }else if(current>=0)updateTicker(now);
  }
  if (list && scroller) {
    const followLatest=newest!==lastNewest&&state.preferences.autoScroll&&(mode!=='feed'||!search);
    if(followLatest&&visibleStart>0){visibleStart=0;visibleCount=40;}
    const oldScroll = scroller.scrollTop;
    const oldFirst = [...list.children].find(node => (node as HTMLElement).offsetTop + (node as HTMLElement).offsetHeight >= oldScroll) as HTMLElement | undefined;
    const anchorID = oldFirst?.dataset.id, anchorOffset = oldFirst ? oldFirst.offsetTop - oldScroll : 0;
    const anchorIndex=groups.findIndex(group=>group.id===anchorID);
    if(!followLatest&&anchorIndex>=visibleStart+visibleCount-5)visibleCount=anchorIndex-visibleStart+20;
    const shown=groups.slice(visibleStart,visibleStart+visibleCount);
    const wanted = new Set(shown.map(g => g.id));
    list.querySelector('.empty')?.remove();list.querySelectorAll('.load-older').forEach(node=>node.remove());
    for (const [id, cached] of rowNodes) if (!wanted.has(id)) { cached.node.remove(); rowNodes.delete(id); }
    const retained = new Set([...state.items, ...state.unread].map(i => i.id));
    for (const id of expandedStories) if (!retained.has(id)) expandedStories.delete(id);
    for (const id of openStoryDetails) if (!retained.has(id)) openStoryDetails.delete(id);
    let cursor: ChildNode | null = list.firstChild;
    for (const group of shown) {
      const key = JSON.stringify([group.members, state.preferences.keywords, state.preferences.interests, state.preferences.threshold, modeInfo(), state.unread.some(i => group.members.some(m => m.id === i.id))]);
      let cached = rowNodes.get(group.id);
      if (!cached || cached.key !== key) {
        const node = row(group);
        // An unchanged row keeps its DOM node and text selection through refreshes.
        if (cached) { cached.node.replaceWith(node); if (cursor === cached.node) cursor = node; }
        cached = { node, key }; rowNodes.set(group.id, cached);
      }
      if (cached.node !== cursor) list.insertBefore(cached.node, cursor);
      cursor = cached.node.nextSibling;
    }
    if (!groups.length) {
      const empty = el('div', 'empty');
      if (mode === 'feed' && search.trim()) {
        empty.append(el('p', 'empty-title', '没有找到相关快讯'), el('p', '', '试试其他关键词，或清除搜索查看消息。'), button('清除搜索', () => { applySearch(''); root.querySelector<HTMLInputElement>('.search-input')?.focus(); }, 'empty-action'));
      } else if (mode === 'feed' && selectedSource) {
        empty.append(el('p', 'empty-title', '此来源暂无快讯'), el('p', '', '可以切换其他来源，或等待下一次更新。'));
      } else if (!state.preferences.sources.length) {
        empty.append(el('p','empty-title','还没有启用新闻来源'),el('p','','在设置中添加并开启新闻来源，即可开始阅读。'),button('添加来源',()=>void setMode('settings'),'empty-action'));
      } else {
        empty.append(el('p', 'empty-title', refreshing ? '正在连接财经快讯…' : '等待新快讯'), el('p', '', '连接异常时会保留缓存并自动重试。'));
      }
      list.append(empty);
    }
    if(visibleStart>0)list.prepend(button('查看更新的新闻',()=>{const count=Math.min(40,visibleStart);visibleStart-=count;visibleCount+=count;updateView();},'load-older load-newer'));
    if(visibleStart+shown.length<groups.length)list.append(button('查看更早的新闻',loadOlder,'load-older'));
    updatePreviews();
    // Expanded views stay still. Only an actual new/corrected latest story
    // brings the view to the top; time passing never scrolls into history.
    if (newest !== lastNewest && state.preferences.autoScroll && (mode !== 'feed' || !search)) {
      scroller.scrollTop = 0;
      follow.resume();
    } else if (anchorID) {
      const anchor = rowNodes.get(anchorID)?.node;
      if (anchor) scroller.scrollTop = anchor.offsetTop - anchorOffset;
    }
    autoOffset = scroller.scrollTop;
  }
  lastNewest = newest; renderStatus();
}
async function openCurrentStory(selected?:NewsGroup){
  const target=selected??groups[tickerIndex];if(!target){await setMode(state.preferences.sources.length?'glance':'settings');return;}
  const ids=new Set(target.members.map(item=>item.id));search='';selectedSource=undefined;readingToolsOpen=false;
  await setMode('glance');const index=groups.findIndex(group=>group.members.some(item=>ids.has(item.id)));if(index<0)return;
  expandedStories.add(groups[index].id);visibleStart=Math.max(0,index-3);visibleCount=40;updateView();
  const article=rowNodes.get(groups[index].id)?.node;if(article&&scroller){scroller.scrollTop=article.offsetTop;autoOffset=scroller.scrollTop;article.tabIndex=-1;article.focus({preventScroll:true});follow.manual(performance.now());renderStatus();}
}
function finishTicker(now:number){
  recordTickerPlayback(now);
  const next=tickerNext;
  if(next){
    const index=groups.findIndex(g=>sameTickerStory(g,next));tickerIndex=Math.max(0,index);tickerID='';updateTicker(now,true,next);
    if(index<0){const pending=groups.find(g=>!state.preferences.skipPlayed||!playback.has(g.item));if(pending)incomingTicker(pending,now);}
  }
  else{tickerPhase='idle';marquee?.pause(now);prepareTickerNext();}
}
function advanceTicker(now: number, direction=1, continuous=false) {
  if (!groups.length) return;
  tickerIndex = (tickerIndex + direction + groups.length) % groups.length;
  tickerOutgoing?.remove();tickerOutgoing=null;tickerID = '';
  updateTicker(now,continuous);
}
function manualNext() {
  manualPage(1);
}
function manualPage(direction:number) {
  const now = performance.now();
  advanceTicker(now,direction);
  follow.resume(); pagePauseUntil=now+2200;
}
function updateTicker(now: number, continuous=false, selected?:NewsGroup) {
  if (!ticker || !tickerCopy) return;
  tickerIndex = Math.min(tickerIndex, Math.max(0, groups.length - 1));
  const group = selected??groups[tickerIndex];
  const id = group ? `${group.id}:${text(group.item)}` : '';
  tickerCopy.classList.toggle('matched', !!group?.members.some(i => isMatch(i, state.preferences, modeInfo().ai)));
  const changed=tickerID===''||!sameTickerStory(group,tickerCurrent);
  if(changed){
    tickerCurrent=group;tickerRecorded=false;tickerID=id;
    paintTicker(tickerCopy,group);
    if(!group)tickerCopy.textContent=!state.preferences.sources.length?'点击添加新闻来源':paused?'已暂停更新':refreshing?'正在连接…':'等待新快讯';
    ticker.title=tickerCopy.textContent??'';marquee?.jump(0);autoOffset=0;tickerPhase=continuous?'moving':'start';holdUntil=now+2200;
  }
  prepareTickerNext();
  if(changed&&continuous){
    if(tickerOverflows)marquee?.play(marqueeDistance,state.preferences.scrollSpeed,now);
    else{tickerPhase='end';holdUntil=now+4200;}
  }
}
function buttonLabel(node:HTMLButtonElement,label:string){
  if(node.textContent!==label)node.textContent=label;
  node.title=label;node.setAttribute('aria-label',label);
}
function renderStatus() {
  const errors = issues(), failed = errors.length > 0;
  for(const control of root.querySelectorAll<HTMLButtonElement>('.update-toggle'))buttonLabel(control,paused?'继续更新':'暂停更新');
  for(const control of root.querySelectorAll<HTMLButtonElement>('.refresh-control')){control.disabled=refreshing;buttonLabel(control,refreshing?'刷新中':'立即刷新');}
  for(const control of root.querySelectorAll<HTMLButtonElement>('[data-ai-control]')){
    control.hidden=mode==='settings'&&!state.preferences.aiEnabled&&!aiStarting;
    buttonLabel(control,aiMenuLabel());control.classList.toggle('ai-running',state.preferences.aiEnabled&&!state.preferences.aiPaused);
  }
  const aiEnabledInput=root.querySelector<HTMLInputElement>('[data-ai-enabled]');if(aiEnabledInput)aiEnabledInput.checked=(settingsDraft??state.preferences).aiEnabled;
  const usageLabel=root.querySelector('.ai-usage');if(usageLabel)usageLabel.textContent=`过去 24 小时：提交 ${aiUsage.items} 条新闻 · 发起 ${aiUsage.requests} 次请求（含试判、失败和取消）。`;
  const safetyControl=root.querySelector<HTMLButtonElement>('.ai-safety-control');if(safetyControl){buttonLabel(safetyControl,state.preferences.aiPaused?'继续 AI 判断':'立即停止 AI');safetyControl.classList.toggle('ai-running',!state.preferences.aiPaused);}
  for(const control of root.querySelectorAll<HTMLButtonElement>('.ticker-next,.ticker-previous'))control.disabled=groups.length<2;
  const filterLabel=root.querySelector('.filter-label');
  if(filterLabel){const mode=modeInfo(),cached=groups.some(g=>g.members.some(i=>{const j=currentJudgement(i,state.preferences);return j&&(j.kind==='json'?j.relevant===true:j.probability>=state.preferences.threshold);}));const label=!mode.ai&&cached?(mode.keyword?'关键词 · 已有 AI 标记':'已有 AI 标记'):mode.label;if(filterLabel.textContent!==label)filterLabel.textContent=label;}
  const toolsLabel = root.querySelector('.reading-tools-label');
  if (toolsLabel) toolsLabel.textContent = [search ? `搜索：${search}` : '', selectedSource ? sourceName(selectedSource,state.preferences) : ''].filter(Boolean).join(' · ') || '搜索与来源';
  const refreshControl = root.querySelector<HTMLButtonElement>('.refresh-control');
  if (refreshControl) { refreshControl.disabled = refreshing || paused; refreshControl.classList.toggle('is-refreshing', refreshing); refreshControl.setAttribute('aria-busy', String(refreshing)); }
  root.querySelector('.panel')?.classList.toggle('is-paused', paused);
  renderPin();
  if (followButton) {
    const browsing = (scroller?.scrollTop ?? 0) > 3;
    followButton.className = `follow-button ${browsing ? 'browsing' : state.preferences.autoScroll ? 'following' : ''}`;
    const label = paused ? '已暂停更新' : browsing ? '阅读历史 · 回到最新' : state.preferences.autoScroll ? '跟随最新' : '回到最新';
    if(followButton.dataset.label!==label){followButton.dataset.label=label;followButton.innerHTML = icon('follow'); followButton.append(document.createTextNode(label));}
  }
  if (statusButton) {
    statusButton.setAttribute('aria-expanded', String(diagnosticsOpen));
    statusButton.className = failed ? 'status-button' : 'status-button status-ok';
    const lastSuccess = Math.max(0, ...[...feedStates.values()].map(s => s.success ?? 0));
    statusButton.textContent = failed ? `${errors.length} 项连接提示` : paused ? '已暂停' : analysisQueue.waitUntil>Date.now()&&!state.preferences.aiPaused ? 'AI 等待下一批' : judging ? 'AI 判断中' : refreshing ? '更新中…' : lastSuccess ? `更新 ${formatTime(lastSuccess)}` : native ? '连接中…' : '示例数据';
    statusButton.title = diagnosticsOpen ? '收起连接详情' : failed ? '查看连接问题与重试状态' : lastSuccess ? `最近更新 ${formatTime(lastSuccess)} · 查看连接详情` : '查看连接详情';
  }
  if (diagnostics) {
    diagnostics.hidden = !diagnosticsOpen;
    const successes = allSources(state.preferences).filter(s => state.preferences.sources.includes(s)).map(s => { const status = feedStates.get(s); return `${sourceName(s,state.preferences)}：${status?.error ?? (status?.success ? `${status.count} 条 · ${formatTime(status.success)}${status.warning?` · ${status.warning}`:''}` : '等待连接')}`; });
    diagnostics.textContent = [...successes, ...((aiError||aiBatchError) ? [`AI：${aiError||aiBatchError}（待处理保留，不会隐藏新闻）`] : []), ...(state.preferences.aiEnabled?[state.preferences.aiPaused?'AI 已停止；已有标记保留':quotaBlocked?'AI 已达到保护上限，新的判断已暂停':analysisQueue.waitUntil>Date.now()?'AI 按频率等待下一批，将自动继续':judging?'AI 正在后台判断':'AI 等待符合时间范围的新新闻',...(analysisClient.skippedLong?[`${analysisClient.skippedLong} 条新闻超过单次文字范围，保留原文，未发送 AI`]:[])]:[]),...(storageError ? [storageError] : []), '来源连接失败时保留缓存并自动重试。'].join('\n');
    if(aiError||aiBatchError)diagnostics.append(button('重试待处理 AI',retryAI,'text-action'));
  }
}
function tick(now:number){
  lastFrame=now;if(mode!=='compact'||!marquee)return;
  follow.hovering=hoverPill&&!pagePauseUntil;
  const can=!paused&&(!pagePauseUntil||now>=pagePauseUntil)&&follow.canFollow(now)&&(native||!document.hidden);
  if(!can){marquee.pause(now);return;}
  if(follow.browsing)follow.resume();
  if(!groups.length||tickerPhase==='idle')return;
  if(tickerPhase==='incoming'){marquee.play(marqueeDistance,state.preferences.scrollSpeed,now);if(marquee.position(now)>=marqueeDistance)finishIncomingTicker(now);return;}
  if(tickerPhase==='start'&&now>=holdUntil){
    if(tickerOverflows)tickerPhase='moving';
    else{tickerPhase='end';holdUntil=now+4200;}
  }
  if(tickerPhase==='end'&&now>=holdUntil)tickerPhase='moving';
  if(tickerPhase==='moving'){
    marquee.play(marqueeDistance,state.preferences.scrollSpeed,now);recordTickerPlayback(now);
    if(marquee.position(now)>=marqueeDistance)finishTicker(now);
  }
}
function frameLoop(now: number) { tick(now); requestAnimationFrame(frameLoop); }
function ingest(results: FeedResult[]) {
  if (paused) return;
  for (const result of results) {
    if(!state.preferences.sources.includes(result.source))continue;
    const old = feedStates.get(result.source);
    try {
      if (result.error || result.text == null) throw new Error(result.error || '未返回数据');
      const items = parseFeed(result.source, result.text!); syncAnalysisPending(state,items);state.items = merge(state.items, items);
      feedStates.set(result.source, { success: result.fetchedAt * 1000, count: items.length,warning:result.warning??undefined });
    } catch (error) { feedStates.set(result.source, { ...old, count: old?.count ?? 0, error: error instanceof Error ? error.message : String(error) }); }
  }
  syncAnalysisPending(state);scheduleAttention(); updateView(); void persist(); void screenNews();
}
async function refresh() {
  if (refreshing) return;
  refreshing = true; renderStatus();
  try { ingest(await bridge.refresh()); } catch { for (const source of state.preferences.sources) feedStates.set(source, { count: 0, error: '暂时无法连接，稍后自动重试' }); }
  finally { refreshing = false; updateView(); }
}
function togglePause() { paused = !paused;void bridge.pause(paused);if(paused)marquee?.pauseVisual();else{void refresh();void screenNews();}updateView(); }
function screenNews(){if(quotaBlocked&&aiUsage.resetAt&&Date.now()>=aiUsage.resetAt){quotaBlocked=false;void bridge.aiUsage().then(value=>aiUsage=value);}analysisQueue.wake();}

function renderSettings(panel: HTMLElement) {
  const prefs: Preferences = structuredClone(state.preferences), scroll = el('form', 'settings-scroll');
  settingsDraft=prefs;
  const section = (title: string) => { const node = el('section', 'settings-section'); node.append(el('h2', 'settings-title', title)); scroll.append(node); return node; };
  function checkbox(parent: HTMLElement, label: string, checked: boolean, change: (value: boolean) => void) {
    const line = el('div', 'setting-line'), wrap = el('label'), input = el('input'); input.type = 'checkbox'; input.checked = checked; input.addEventListener('change', () => change(input.checked)); wrap.append(input, document.createTextNode(label)); line.append(wrap); parent.append(line); return input;
  }
  function field(parent: HTMLElement, label: string, value: string, change: (value: string) => void, multiline = false) {
    const wrapper = el('label', 'field-label', label), input = multiline ? el('textarea', 'field') : el('input', 'field'); input.value = value; input.addEventListener('input', () => change(input.value)); wrapper.append(input); parent.append(wrapper); return input;
  }
  function select(parent: HTMLElement, label: string, options: [string, string][], value: string, change: (value: string) => void) {
    const line = el('label', 'setting-line', label), input = el('select'); input.setAttribute('aria-label',label); for (const [v, name] of options) { const option = el('option', '', name); option.value = v; input.append(option); } input.value = value; input.addEventListener('change', () => change(input.value)); line.append(input); parent.append(line); return input;
  }
  const feeds = section('新闻来源'), sourceOptions = el('div', 'installed-channels'); sourceOptions.setAttribute('aria-label','已安装来源'); feeds.append(sourceOptions);
  select(feeds, '更新间隔', [['30','30 秒'],['60','60 秒'],['120','2 分钟']], String(prefs.interval), v => { prefs.interval = Number(v); });
  const sourceKeyEdits=new Map<string,string>();const adapterErrors=new Map<string,string>();const expandedConfigs=new Set<string>();
  const custom=el('details','settings-disclosure custom-sources');custom.append(el('summary','','添加新闻来源'));feeds.append(custom);
  const available=el('div','available-channels');available.setAttribute('aria-label','可安装来源');custom.append(available);
  custom.append(el('p','hint','添加订阅地址，或选择开发者提供的来源文件。卸载的来源也可以在这里装回。'));
  const editors=sourceOptions;
  function renderSourceEditors(){
    editors.replaceChildren();
    available.replaceChildren();
    for(const id of catalogSources(prefs)){
      const source=channelSource(id,prefs), name=sourceName(id,prefs);
      const executable=source?.format==='plugin';
      const group=el('section',`source-entry ${executable?'plugin-source':source?'custom-source':'builtin-source'}`);group.dataset.sourceId=id;group.setAttribute('aria-label',executable?`${name}来源`:source?'自定义来源':`${name}来源`);
      const kind=['cls','wallstreet','jin10'].includes(id)?'内置':'自定义';
      const line=el('div','channel-line');group.append(line);
      if(!isInstalled(prefs,id)){
        const caption=el('div','channel-caption');caption.append(el('span','channel-name',name),el('span','channel-kind',kind));const install=button(`安装${name}`,()=>{installChannel(prefs,id);renderSourceEditors();},'channel-install');install.textContent='安装';line.append(caption,install);
        available.append(group);continue;
      }
      editors.append(group);
      const toggle=checkbox(line,name||'新来源',prefs.sources.includes(id),enabled=>enableChannel(prefs,id,enabled));
      const label=toggle.parentElement!;const nameNode=label.lastChild!;
      const remove=button(`卸载${name||'新来源'}`,()=>{
        if(source){
          const invalid=validateSources({...prefs,customSources:[source],sources:[],uninstalledSources:[]});
          if(invalid){const original=state.preferences.customSources.find(item=>item.id===id);if(original)Object.assign(source,structuredClone(original));else{prefs.customSources=prefs.customSources.filter(item=>item.id!==id);prefs.sources=prefs.sources.filter(item=>item!==id);sourceKeyEdits.delete(id);adapterErrors.delete(id);renderSourceEditors();return;}}
        }
        uninstallChannel(prefs,id);sourceKeyEdits.delete(id);adapterErrors.delete(id);renderSourceEditors();custom.open=true;
      },'channel-uninstall');
      remove.textContent='卸载';line.append(el('span','channel-kind',kind),remove);
      if(!source)continue;
      const editor=el('details','source-editor');editor.open=expandedConfigs.has(id)||!source.url;editor.addEventListener('toggle',()=>{if(editor.open)expandedConfigs.add(id);else expandedConfigs.delete(id);});const summary=el('summary','',executable&&!source.plugin!.manifest.config.length&&!source.plugin!.manifest.auth?'详情':'配置');editor.append(summary);group.append(editor);
      if(source.plugin){
        const manifest=source.plugin.manifest;
        editor.append(el('p','hint',`版本 ${manifest.version} · 可访问 ${manifest.network.join('、')}`));
        const retain=()=>{if(!prefs.customSources.some(s=>s.id===id))prefs.customSources.push(source);};
        for(const parameter of manifest.config){
          const value=source.parameters?.[parameter.key]??parameter.default;
          const set=(next:string|number|boolean)=>{retain();source.parameters??={};source.parameters[parameter.key]=next;};
          if(parameter.kind==='boolean')checkbox(editor,parameter.label,Boolean(value),set);
          else {const input=field(editor,parameter.label,String(value),next=>set(parameter.kind==='number'?Number(next):next));if(parameter.kind==='number')(input as HTMLInputElement).type='number';}
        }
        let secret:HTMLInputElement|undefined;
        if(manifest.auth){
          secret=field(editor,'来源 Key',sourceKeyEdits.get(id)??'',value=>{retain();sourceKeyEdits.set(id,value);}) as HTMLInputElement;secret.type='password';secret.autocomplete='new-password';secret.placeholder='留空保持已保存的 Key';
          editor.append(button('删除来源已存 Key',()=>{retain();sourceKeyEdits.set(id,'');secret!.value='';secret!.placeholder='保存设置后删除 Key';},'text-action'));
        }
        const status=el('p','hint connection-test-result');status.setAttribute('role','status');
        const test=button('测试来源',()=>{void (async()=>{
          status.textContent='正在执行来源…';test.disabled=true;
          try{const error=validatePluginSource(source);if(error)throw error;const result=await bridge.testSource(source,sourceKeyEdits.get(id));if(result.error||result.text==null)throw result.error||'未返回数据';const items=parseFeed(id,result.text);status.textContent=`执行成功：${items.length} 条标准新闻。${result.warning??''}`;}
          catch(error){status.textContent=typeof error==='string'?error:'来源测试未完成';}
          finally{test.disabled=false;}
        })();},'text-action');editor.append(test,status);continue;
      }
      field(editor,'来源名称',source.name,value=>{source.name=value;nameNode.textContent=value||'新来源';remove.title=`卸载${value||'新来源'}`;remove.setAttribute('aria-label',remove.title);});
      field(editor,'订阅或接口 URL',source.url,value=>{source.url=value;sourceKeyEdits.delete(source.id);secret.value='';secret.placeholder='地址已更改，留空使用此地址已存 Key';});
      select(editor,'来源格式',[['auto','自动识别'],['feed','RSS / Atom / JSON Feed'],['json','标准 JSON 接口'],['adapter','本地 JSON 适配器']],source.format??'auto',value=>{source.format=value as CustomSource['format'];rulesField.closest('label')!.hidden=value!=='adapter';});
      const rulesField=field(editor,'本地适配器规则',source.adapter?JSON.stringify(source.adapter,null,2):'',value=>{try{const rules=JSON.parse(value);const error=validateAdapter(rules);if(error){adapterErrors.set(source.id,error);}else{source.adapter=rules;adapterErrors.delete(source.id);}}catch{adapterErrors.set(source.id,'适配器规则不是合法 JSON');}},true);rulesField.closest('label')!.hidden=source.format!=='adapter';
      field(editor,'来源分组',source.folder??'',value=>{source.folder=value;});
      select(editor,'来源鉴权',[['none','无需鉴权'],['bearer','Bearer Key']],source.auth,value=>{source.auth=value as 'none'|'bearer';secret.disabled=value!=='bearer';});
      const secret=field(editor,'来源 Key',sourceKeyEdits.get(source.id)??'',value=>{sourceKeyEdits.set(source.id,value);}) as HTMLInputElement;
      secret.type='password';secret.autocomplete='new-password';secret.disabled=source.auth!=='bearer';secret.placeholder=sourceKeyEdits.get(source.id)===''?'保存设置后删除 Key':'留空保持此来源已存 Key';
      const status=el('p','hint connection-test-result');status.setAttribute('role','status');
      const test=button('测试来源',()=>{void runTest();},'text-action');
      const runTest=async()=>{
        status.textContent='正在读取接口…';test.disabled=true;
        try {if(source.format==='adapter'&&adapterErrors.has(source.id))throw adapterErrors.get(source.id);if(!source.name.trim()||!validSourceURL(source.url))throw '请先填写来源名称和有效 URL';const result=await bridge.testSource(source,sourceKeyEdits.get(source.id));if(result.error||result.text==null)throw result.error||'未返回数据';const items=parseFeed(source.id,result.text!);status.textContent=`格式正确：读取 ${items.length} 条新闻。保存后自动更新。`;}
        catch(error){status.textContent=typeof error==='string'?error:error instanceof Error?error.message:'测试未完成';}
        finally{test.disabled=false;}
      }
      editor.append(test,button('删除来源已存 Key',()=>{sourceKeyEdits.set(source.id,'');secret.value='';secret.placeholder='保存设置后删除 Key';},'text-action'),status);
    }
    addSource.disabled=prefs.customSources.length>=maxSources;
    if(!available.children.length)available.append(el('p','hint','目录中的来源均已安装。'));
    if(!editors.children.length)editors.append(el('p','hint','尚未安装来源。打开下方“安装来源”选择或导入。'));
  }
  const addSource=button('添加来源',()=>{if(prefs.customSources.length>=maxSources)return;const id=`custom:${Date.now().toString(36)}-${Math.random().toString(36).slice(2,10)}`;prefs.customSources.push({id,name:'',url:'',auth:'none',format:'auto',folder:''});installChannel(prefs,id);renderSourceEditors();editors.lastElementChild?.querySelector('input:not([type=checkbox])')?.scrollIntoView({block:'nearest'});},'text-action');custom.append(addSource);
  const importPanel=el('div','subscription-import');custom.append(importPanel);
  const batch=el('details','settings-disclosure import-text-editor');batch.append(el('summary','','批量添加与 OPML'));importPanel.append(batch);
  let previewGeneration=0;
  const batchInput=field(batch,'订阅地址或订阅目录','',()=>{previewGeneration++;preview=undefined;confirm.disabled=true;},true);batchInput.placeholder='每行一个订阅地址，或粘贴 OPML / JSON 来源目录';
  const importStatus=el('p','hint');importStatus.hidden=true;importStatus.setAttribute('role','status');const previewList=el('ul','subscription-preview');previewList.hidden=true;
  let preview:ImportPreview|undefined;
  const confirm=button('安装这些来源',()=>{
    if(!preview)return;preview=previewSubscriptions(batchInput.value,prefs);const count=installationCount(preview);for(const source of preview.updates){prefs.customSources=prefs.customSources.filter(s=>s.id!==source.id);prefs.customSources.push(source);}for(const source of preview.sources)prefs.customSources.push(source);for(const id of [...preview.sources.map(source=>source.id),...preview.updates.map(source=>source.id),...preview.reinstalls])installChannel(prefs,id);importStatus.textContent=`已安装${count}个来源，保存后开始更新。`;preview=undefined;confirm.disabled=true;confirm.hidden=true;previewList.hidden=true;previewList.replaceChildren();renderSourceEditors();
  },'text-action');confirm.disabled=true;confirm.hidden=true;
  const inspect=button('预览导入',()=>{void (async()=>{
    const generation=++previewGeneration;confirm.disabled=true;confirm.hidden=false;importStatus.hidden=false;previewList.hidden=false;
    const next=previewSubscriptions(batchInput.value,prefs);preview=undefined;
    importStatus.textContent=`可安装${installationCount(next)}个，重复${next.duplicates}个。${next.issues.join('；')}`;
    const description=(source:CustomSource)=>source.plugin?`${source.name} · v${source.plugin.manifest.version} · 网络：${source.plugin.manifest.network.join('、')}${source.plugin.manifest.auth?' · 需 Key':''}`:`${source.folder?source.folder+' / ':''}${source.name} · ${new URL(source.url).hostname}${source.auth==='bearer'?' · 需 Key':''}`;
    previewList.replaceChildren(...next.reinstalls.map(id=>el('li','',`${sourceName(id,prefs)} · 重新安装`)),...next.updates.map(source=>el('li','',`更新／替换 · ${description(source)}`)),...next.sources.map(source=>el('li','',description(source))));
    try{
      const packages=[...next.sources,...next.updates].flatMap(source=>source.plugin?[source.plugin]:[]);
      if(packages.length){importStatus.textContent+=' 检查脚本中…';await bridge.inspectPackages(packages);}
      if(generation!==previewGeneration)return;
      preview=next;confirm.disabled=!installationCount(next);
      importStatus.textContent=`可安装${installationCount(next)}个，重复${next.duplicates}个。${next.issues.join('；')}${packages.length?' 来源包检查通过；安装后可在配置中测试。':''}`;
    }catch(error){if(generation===previewGeneration)importStatus.textContent=typeof error==='string'?error:'来源包检查失败';}
  })();},'text-action');
  const fileInput=el('input');fileInput.type='file';fileInput.accept='.opml,.xml,.json,.txt';fileInput.hidden=true;
  fileInput.addEventListener('change',()=>{void (async()=>{const file=fileInput.files?.[0];if(!file)return;const generation=++previewGeneration;preview=undefined;confirm.disabled=true;importStatus.hidden=false;if(file.size>1024*1024){importStatus.textContent='导入文件最多1 MiB';return;}const contents=await file.text();if(generation!==previewGeneration)return;batchInput.value=contents;preview=undefined;confirm.disabled=true;inspect.click();fileInput.value='';})().catch(()=>{importStatus.textContent='无法读取订阅文件';});});
  const exported=field(batch,'导出的订阅文本','',()=>{},true);exported.readOnly=true;exported.closest('label')!.hidden=true;
  const exportButton=button('导出 OPML',()=>{void (async()=>{importStatus.hidden=false;exported.value=exportOPML(prefs.customSources.filter(source=>isInstalled(prefs,source.id)));exported.closest('label')!.hidden=false;importStatus.textContent=(await bridge.exportSubscriptions(exported.value))+(prefs.customSources.some(s=>s.format==='adapter')?'；本地适配器请使用完整来源目录导出。':'');})().catch(error=>{importStatus.textContent=typeof error==='string'?error:'导出失败，可复制文本手动保存';});},'text-action');
  const exportDirectory=button('导出完整来源目录',()=>{importStatus.hidden=false;exported.value=exportChannelDirectory(prefs);exported.closest('label')!.hidden=false;importStatus.textContent='已生成已安装来源清单，含内置来源和适配器规则、不含 Key；安装时默认启用。可复制保存。';},'text-action');
  custom.insertBefore(button('从文件添加',()=>fileInput.click(),'text-action'),available);
  batch.append(exportDirectory,inspect,exportButton);importPanel.append(fileInput,importStatus,previewList,confirm);
  renderSourceEditors();
  const appearance=section('外观');
  select(appearance,'主题',[['system','跟随系统'],['light','浅色'],['dark','深色']],prefs.theme,value=>{prefs.theme=value as Preferences['theme'];applyAppearance(prefs);});
  select(appearance,'强调色',[['orange','暖橙'],['blue','蓝色'],['green','绿色'],['purple','紫色']],prefs.accent,value=>{prefs.accent=value as Preferences['accent'];applyAppearance(prefs);});
  const play = section('窗口与实时展示');
  checkbox(play,'跳过已播放新闻（收起时）',prefs.skipPlayed,value=>prefs.skipPlayed=value);
  play.append(el('p','hint','播完后自动跳过，手动翻页仍可回看；全部播完后停止滚动，等待新消息。'));  checkbox(play, '窗口置顶', prefs.pinned, v => { prefs.pinned = v; }); checkbox(play, '自动展示最新', prefs.autoScroll, v => { prefs.autoScroll = v; });
  const speedLine=el('div','speed-setting'),speedLabel=el('label','setting-line','阅读速度'),speedOutput=el('output','speed-output');
  const speed=el('input','speed-range');speed.type='range';speed.min='8';speed.max='80';speed.step='1';speed.value=String(prefs.scrollSpeed);speed.id='reading-speed';speed.setAttribute('aria-label','阅读速度');speedLabel.htmlFor=speed.id;speedLabel.append(speedOutput);
  function showSpeed(){speedOutput.textContent=`${(prefs.scrollSpeed/22).toFixed(1)}×`;speed.setAttribute('aria-valuetext',`默认速度的 ${(prefs.scrollSpeed/22).toFixed(1)} 倍`);}
  speed.addEventListener('input',()=>{prefs.scrollSpeed=Number(speed.value);showSpeed();});showSpeed();
  const speedEnds=el('div','speed-ends');speedEnds.append(el('span','','较慢'),button('恢复默认速度',()=>{prefs.scrollSpeed=22;speed.value='22';showSpeed();},'speed-reset'),el('span','','较快'));
  speedLine.append(speedLabel,speed,speedEnds,el('p','hint','调整收起时新闻文字的播放速度。'));play.append(speedLine);
  play.append(el('p', 'hint', '开启时，新快讯到达即显示最新；关闭后保留阅读位置。展开列表不会自动向历史滚动。'));
  const keyword = section('关键词');
  const keywordToggle = checkbox(keyword, '关键词高亮', prefs.keywordEnabled, v => { prefs.keywordEnabled = v; keywordField.disabled = !v; keywordFields.hidden = !v; keywordToggle.setAttribute('aria-expanded', String(v)); });
  keywordToggle.setAttribute('aria-controls', 'keyword-fields'); keywordToggle.setAttribute('aria-expanded', String(prefs.keywordEnabled));
  const keywordFields = el('div', 'keyword-fields'); keywordFields.id = 'keyword-fields'; keywordFields.hidden = !prefs.keywordEnabled; keyword.append(keywordFields);
  const keywordField = field(keywordFields, '关注词（逗号或换行分隔）', prefs.keywords, v => { prefs.keywords = v; }, true);
  keywordFields.append(el('p', 'hint', '命中的新闻高亮显示，其余新闻正常保留。'));
  keywordField.disabled = !prefs.keywordEnabled; keywordField.placeholder = '例如：美联储，人工智能，新能源';
  const aiSection = section('AI 高亮');aiSection.classList.add('ai-settings');
  const enabledInput=checkbox(aiSection, '用 AI 标记感兴趣的新闻', prefs.aiEnabled, v => { prefs.aiEnabled = v; if(v){ai.open=true;prefs.aiPaused=false;}else prefs.aiPaused=true; });enabledInput.dataset.aiEnabled='';
  aiSection.append(el('p', 'hint', '符合关注条件的新闻会高亮，其余新闻照常展示。默认只判断开启后发布或更正的新闻。'));
  const ai = el('details', 'settings-disclosure'); ai.open = prefs.aiEnabled;
  ai.append(el('summary', '', '连接 AI 模型')); aiSection.append(ai);
  select(ai, '接口格式', [['decisions','JEV Decisions'],['chat','Chat Completions'],['messages','Messages'],['responses','Responses']], prefs.ai.format, v => { prefs.ai.format = v as Preferences['ai']['format'];updateProtocolFields(); });
  const endpointField = field(ai, '服务地址（完整 API URL）', prefs.ai.apiUrl, v => { prefs.ai.apiUrl = v; keyChangedHost(); });
  field(ai, '模型名称', prefs.ai.model, v => { prefs.ai.model = v; });
  let newKey: string | undefined, keyHost = prefs.ai.apiUrl;
  const keyField = field(ai, 'API Key', '', v => { newKey = v; }) as HTMLInputElement;
  ai.append(el('p','hint','Key 以明文保存在本机，不随配置导出。'));
  keyField.type = 'password'; keyField.autocomplete = 'new-password'; keyField.placeholder = hasKey ? '已保存 · 留空保持原 Key' : '留空保留已保存的 Key';
  function keyChangedHost() {
    if (!keyField) return;
    if (keyHost !== endpointField.value) { keyField.value = ''; newKey = undefined; keyField.placeholder = '新地址 · 填写此服务的 Key，留空使用已保存的 Key'; keyHost = endpointField.value; }
  }
  ai.append(button('删除此地址已保存的 Key', () => { newKey = ''; keyField.value = ''; keyField.placeholder = '保存设置后删除 Key'; }, 'quit-button'));
  field(ai, '我关注什么', prefs.interests, v => { prefs.interests = v; }, true);
  ai.append(el('p','hint','例如：关注美联储利率决议和 AI 芯片，忽略明星、体育与广告。'));
  const threshold=select(ai, 'JEV 高亮阈值', [['0.5','50%'],['0.7','70%'],['0.9','90%']], String(prefs.threshold), v => { prefs.threshold = Number(v); });
  const advanced=el('details','settings-disclosure ai-advanced');advanced.append(el('summary','','高级设置'));ai.append(advanced);
  const systemField=field(advanced,'系统提示词',prefs.ai.systemPrompt,value=>{prefs.ai.systemPrompt=value;},true);
  advanced.append(button('恢复默认系统提示词',()=>{prefs.ai.systemPrompt=defaultSystemPrompt;systemField.value=defaultSystemPrompt;},'text-action'));
  select(advanced,'鉴权方式',[['auto','按协议自动'],['bearer','Bearer Key'],['x-api-key','x-api-key']],prefs.ai.auth,value=>{prefs.ai.auth=value as Preferences['ai']['auth'];});
  const apiVersion=field(advanced,'Messages API 版本',prefs.ai.apiVersion,value=>{prefs.ai.apiVersion=value;});
  const jsonMode=select(advanced,'JSON 约束方式',[['prompt','提示词约束（兼容优先）'],['object','JSON Object'],['schema','JSON Schema（需接口支持）']],prefs.ai.jsonMode,value=>{prefs.ai.jsonMode=value as Preferences['ai']['jsonMode'];});
  const contract=el('pre','output-contract','{"schemaVersion":1,"results":[{"id":"输入新闻ID","relevant":true,"reason":"与关注主题直接相关","tags":["主题"]}]}');advanced.append(contract);
  const contractHint=el('p','hint');advanced.append(contractHint);
  function updateProtocolFields(){
    const jev=prefs.ai.format==='decisions',messages=prefs.ai.format==='messages';
    jsonMode.closest('label')!.hidden=jev;apiVersion.closest('label')!.hidden=!messages;contract.hidden=jev;
    for(const option of jsonMode.options)option.disabled=messages&&option.value==='object';
    if(messages&&prefs.ai.jsonMode==='object'){prefs.ai.jsonMode='prompt';jsonMode.value='prompt';}
    threshold.closest('label')!.hidden=!jev;outputTokens.closest('label')!.hidden=jev;
    contractHint.textContent=jev?'JEV 使用 Noul 问题，只按返回概率与阈值判断；不要求生成 JSON 文本。':'批量返回每个新闻 ID 的结果。relevant 决定 AI 高亮，reason 可展开查看，tags 单独展示。JSON 格式错误不会隐藏新闻。';
  }
  select(advanced,'模型思考模式',[['default','接口默认'],['disabled','关闭思考（需接口支持）']],prefs.ai.thinkingMode,value=>{prefs.ai.thinkingMode=value as Preferences['ai']['thinkingMode'];});
  select(advanced,'每批最多新闻',[['1','1 条'],['4','4 条'],['8','8 条'],['16','16 条'],['20','20 条']],String(prefs.ai.batchSize),value=>{prefs.ai.batchSize=Number(value);});
  advanced.append(el('p','hint','按所选频控窗口内的新闻速度与篇幅平滑估算合批，零散新闻最多额外等待 2 秒。每批不超过条数和字符上限。'));
  const safety=el('details','settings-disclosure ai-safety');safety.open=prefs.aiEnabled;safety.append(el('summary','','判断范围与用量保护'));aiSection.append(safety);
  safety.append(button(state.preferences.aiPaused?'继续 AI 判断':'立即停止 AI',()=>void controlAI(!state.preferences.aiPaused),'ai-safety-control text-action'));
  const usageText=el('p','hint ai-usage');safety.append(usageText);
  checkbox(safety,'只判断开启后发布或更正的新闻',prefs.aiLimits.newOnly,value=>prefs.aiLimits.newOnly=value);
  select(safety,'只判断最近',[['15','15 分钟'],['30','30 分钟'],['60','1 小时'],['360','6 小时'],['1440','24 小时']],String(prefs.aiLimits.lookbackMinutes),value=>prefs.aiLimits.lookbackMinutes=Number(value));
  function limit(label:string,value:number,min:number,max:number,change:(value:number)=>void){const input=field(safety,label,String(value),v=>change(Number(v))) as HTMLInputElement;input.type='number';input.min=String(min);input.max=String(max);input.required=true;input.step='1';return input;}
  const cadence=el('p','hint ai-cadence');
  function updateCadence(){cadence.textContent=`请求最短间隔 ${requestInterval(prefs.aiLimits)/1000} 秒；按请求频控窗口平滑合批。`;}
  select(safety,'请求频控窗口',[['1','1 分钟'],['5','5 分钟'],['15','15 分钟'],['30','30 分钟'],['60','1 小时']],String(prefs.aiLimits.requestWindowMinutes??1),value=>{prefs.aiLimits.requestWindowMinutes=Number(value);updateCadence();});
  limit('窗口内最多请求（次）',prefs.aiLimits.maxRequestsPerMinute,1,120,value=>{prefs.aiLimits.maxRequestsPerMinute=value;updateCadence();});updateCadence();safety.append(cadence);
  select(safety,'同时请求数量',[['1','1 个'],['2','2 个'],['3','3 个'],['4','4 个']],String(prefs.ai.concurrency),value=>prefs.ai.concurrency=Number(value));
  const daily=el('details','settings-disclosure daily-budget');daily.append(el('summary','','每日额度（可选）'));safety.append(daily);
  const dailyFields=el('div');dailyFields.hidden=!prefs.aiLimits.dailyEnabled;
  checkbox(daily,'启用每日硬额度',prefs.aiLimits.dailyEnabled,value=>{prefs.aiLimits.dailyEnabled=value;dailyFields.hidden=!value;for(const input of dailyFields.querySelectorAll('input'))input.disabled=!value;});daily.append(dailyFields);
  function dailyLimit(label:string,value:number,min:number,max:number,change:(value:number)=>void){const input=limit(label,value,min,max,change);dailyFields.append(input.closest('label')!);input.disabled=!prefs.aiLimits.dailyEnabled;}
  dailyLimit('24 小时最多判断（条）',prefs.aiLimits.maxItems24h,1,10000,value=>prefs.aiLimits.maxItems24h=value);
  dailyLimit('24 小时最多请求（次）',prefs.aiLimits.maxRequests24h,1,1000,value=>prefs.aiLimits.maxRequests24h=value);
  dailyLimit('24 小时最多输入（字符）',prefs.aiLimits.maxInputChars24h,2000,10000000,value=>prefs.aiLimits.maxInputChars24h=value);
  const moreLimits=el('details','settings-disclosure');moreLimits.append(el('summary','','更多保护设置'));safety.append(moreLimits);
  const minuteInput=limit('每分钟最多输入（字符）',prefs.aiLimits.maxInputCharsPerMinute,8000,2000000,value=>prefs.aiLimits.maxInputCharsPerMinute=value);moreLimits.append(minuteInput.closest('label')!);
  select(moreLimits,'单次输入上限',[['8000','8,000 字符'],['16000','16,000 字符'],['32000','32,000 字符'],['60000','60,000 字符'],['64000','64,000 字符'],['128000','128,000 字符']],String(prefs.aiLimits.maxCharsPerRequest),value=>prefs.aiLimits.maxCharsPerRequest=Number(value));
  const outputTokens=select(moreLimits,'单次输出上限',[['512','512 tokens'],['1024','1,024 tokens'],['2048','2,048 tokens'],['4096','4,096 tokens']],String(prefs.ai.maxOutputTokens),value=>prefs.ai.maxOutputTokens=Number(value));
  select(moreLimits,'失败后自动重试',[['0','关闭'],['1','最多一次']],String(prefs.aiLimits.maxRetries),value=>prefs.aiLimits.maxRetries=Number(value));
  checkbox(moreLimits,'也判断没有发布时间的新闻',prefs.aiLimits.includeEstimated,value=>prefs.aiLimits.includeEstimated=value);
  safety.append(el('p','hint','命中与未命中的结果都会保存。达到限额时排队，优先判断最新新闻。金额限额请在服务商设置。'));
  const testArea=el('details','settings-disclosure');testArea.append(el('summary','','测试连接'));ai.append(testArea);
  const testInput=field(testArea,'试判新闻','',()=>{},true);testInput.placeholder='粘贴一条新闻，仅在点击试判时发送';
  const testOutput=el('p','hint connection-test-result');testOutput.setAttribute('role','status');
  const tryAI=button('试判一次',()=>{void runAI();},'text-action');
  const stopTest=button('停止试判',()=>void controlAI(true),'text-action');stopTest.hidden=true;
  async function runAI(){
    testOutput.textContent='正在试判…';tryAI.disabled=true;stopTest.hidden=false;
    try {
      if(!testInput.value.trim())throw '请粘贴一条试判新闻';if(!validEndpoint(prefs.ai))throw '请检查 API URL、模型和系统提示词';
      const result=await bridge.testAI(prefs.ai,prefs.interests,{id:'preview:test',source:'preview',title:'',body:testInput.value,publishedAt:Date.now(),url:'',tags:[]},newKey);
      testOutput.textContent=result.kind==='decision'?`JEV 相关概率 ${Math.round(result.probability*100)}% · ${result.probability>=prefs.threshold?'命中':'未命中'}`:`${result.relevant?'命中':'未命中'} · ${result.reason}${result.tags?.length?` · 标签：${result.tags.join('、')}`:''}`;
    }catch(error){const wait=typeof error==='string'?/^AI_WAIT:(\d+)$/u.exec(error):null;testOutput.textContent=wait?`请求频率已满，请约 ${Math.max(1,Math.ceil((Number(wait[1])-Date.now())/1000))} 秒后再试`:typeof error==='string'?error.replace(/^AI_PROVIDER_WAIT:\d+:/u,''):'试判未完成';}finally{tryAI.disabled=false;stopTest.hidden=true;}
  }
  testArea.append(tryAI,stopTest,testOutput,el('p','hint','试判同样受已保存的频率与额度设置约束。'));updateProtocolFields();
  const cache = el('details', 'settings-section settings-disclosure'); cache.append(el('summary', '', '本地数据')); scroll.append(cache); cache.append(el('p', 'hint', '保留最近 7 天、最多 1,000 条原始快讯；重点未读单独保留。旧版受系统保护的缓存不再自动读取，原文件原样保留。'), el('p', 'path', dataPath));
  if (storageError) cache.append(el('p', 'settings-error', storageError));
  const actions = el('div', 'settings-actions'), errorLabel = el('p', 'settings-error settings-save-error'); errorLabel.setAttribute('role', 'alert');
  const save = button('保存', () => { void saveSettings(); }, 'save-button');
  actions.append(button('退出应用', () => void bridge.quit(), 'quit-button'), el('span', 'spacer'), button('取消', () => void setMode(previousMode), 'collapse'), save);
  scroll.addEventListener('submit', event => { event.preventDefault(); void saveSettings(); });
  async function saveSettings() {
    const ruleError=prefs.customSources.find(s=>s.format==='adapter'&&adapterErrors.has(s.id));if(ruleError){errorLabel.textContent=adapterErrors.get(ruleError.id)!;return;}
    const sourceError=validateSources(prefs);if(sourceError){
      errorLabel.textContent=sourceError;
      const invalid=prefs.customSources.find(source=>validateSources({...prefs,customSources:[source],sources:[],uninstalledSources:[]}));
      const group=invalid?[...editors.querySelectorAll<HTMLElement>('.source-entry')].find(node=>node.dataset.sourceId===invalid.id):undefined;
      if(group){const editor=group.querySelector<HTMLDetailsElement>('.source-editor');if(editor)editor.open=true;const inputs=group.querySelectorAll<HTMLInputElement>('input:not([type=checkbox])');(inputs[invalid!.name.trim()&&!validSourceURL(invalid!.url)?1:0])?.focus();}
      else {custom.open=true;feeds.querySelector('input')?.focus();}
      return;
    }
    if ((newKey || prefs.aiEnabled) && !validEndpoint(prefs.ai)) { errorLabel.textContent = '请先填写有效的 HTTPS URL 和模型名称'; ai.open = true; endpointField.focus(); return; }
    if(!scroll.reportValidity())return;
    save.disabled = true;settingsSaving=true;const previousPreferences=state.preferences,revision=aiControlRevision;
    const wantsAI=!prefs.aiPaused;
    const accountChanged=aiAccount(prefs)!==aiAccount(previousPreferences);
    const activatingAI=prefs.aiEnabled&&wantsAI&&(!previousPreferences.aiEnabled||previousPreferences.aiPaused||accountChanged);
    const sourcesChanged=JSON.stringify([prefs.sources,prefs.customSources])!==JSON.stringify([previousPreferences.sources,previousPreferences.customSources]);
    const keyEdited=newKey!==undefined,editedKeyPresent=!!newKey?.trim();
    const aiChanged=newKey!==undefined||JSON.stringify([relevanceConfig(prefs),prefs.interests,prefs.aiEnabled])!==JSON.stringify([relevanceConfig(previousPreferences),previousPreferences.interests,previousPreferences.aiEnabled]);
    if(aiChanged){analysisQueue.stop();analysisClient.invalidate();}
    try {
      for(const source of prefs.customSources){const key=sourceKeyEdits.get(source.id);if(key!==undefined)await bridge.saveSourceKey(source,key);}
      if (newKey !== undefined) await bridge.saveKey(prefs.ai, newKey);
      keyField.value = ''; newKey = undefined; aiError = undefined; aiBatchError=undefined; state.preferences = prefs; sourceKeyEdits.clear();syncAnalysisPending(state);
      if(keyEdited)hasKey=editedKeyPresent;else if(accountChanged||!validEndpoint(prefs.ai))hasKey=false;
      if(activatingAI&&!keyEdited&&!hasKey&&validEndpoint(prefs.ai))hasKey=await bridge.keyStatus(prefs.ai).catch(()=>false);
      if (selectedSource && !prefs.sources.includes(selectedSource)) selectedSource = undefined;
      if(aiChanged){
        const pause=await bridge.setAIPaused(true);prefs.aiPaused=true;prefs.aiStartedAt=pause.startedAt;
        if(revision===aiControlRevision&&prefs.aiEnabled&&wantsAI){const resumed=await bridge.setAIPaused(false,pause.generation);if(revision===aiControlRevision){prefs.aiPaused=resumed.paused;prefs.aiStartedAt=resumed.startedAt;}else await bridge.setAIPaused(true);}
      }
      if(revision!==aiControlRevision)prefs.aiPaused=true;
      scheduleAttention();await persist(true,true);quotaBlocked=false;if(aiChanged)analysisQueue.retry();else analysisQueue.wake(); await setMode(previousMode); void screenNews();if(sourcesChanged)void refresh();
    } catch (error) {if(revision!==aiControlRevision)previousPreferences.aiEnabled=state.preferences.aiEnabled;previousPreferences.aiPaused=true;state.preferences=previousPreferences;void bridge.setAIPaused(true);applyAppearance();errorLabel.textContent = typeof error === 'string' ? error : '保存未完成，请重试'; save.disabled = false; }finally{settingsSaving=false;void screenNews();}
  }
  panel.append(scroll, errorLabel, actions);
}

async function start() {
  let smoke = false;
  try { const loaded = await bridge.load(); state = loaded.state; appName = loaded.appName || appName; dataPath = loaded.dataPath; storageError = loaded.warning; smoke = !!loaded.smoke;nativeCompactDrag=!!loaded.nativeCompactDrag;nativeResizeDrag=!!loaded.nativeResizeDrag; }
  catch { storageError = '本地缓存不可用；本次使用内存模式'; }
  document.title = appName;
  // Keys stay in the native backend; the frontend only receives availability.
  if (state.preferences.aiEnabled && !state.preferences.aiPaused && validEndpoint(state.preferences.ai)) hasKey = await bridge.keyStatus(state.preferences.ai).catch(() => false);
  applyAppearance();follow.auto = state.preferences.autoScroll;
  await bridge.aiEvents(receiveAIPause,usage=>{aiUsage=usage;renderStatus();},()=>void enableAI());
  aiUsage=await bridge.aiUsage().catch(error=>{aiBatchError=String(error);quotaBlocked=true;return aiUsage;});
  scheduleAttention();
  await bridge.events(ingest, next => void setMode(next, true),notifyError,updateNativeHover);
  if(native)updateNativeHover(await bridge.hovered().catch(()=>false));
  if (smoke) state.items = Array.from({length:8}, (_,i) => ({id:`cls:native-test-${i}`,source:'cls',title:`原生窗口测试 ${i}`,body:'用于原生 WebView 滚动验证的长正文。'.repeat(40),publishedAt:Date.now()-i*60_000,url:'',tags:[]}));
  renderShell(); requestAnimationFrame(frameLoop);
  // WKWebView can suspend rAF in a non-activating accessory window. Keep the
  // visible desktop ticker moving without requiring a click to activate it.
  if (native) setInterval(() => { const now = performance.now(); if (now - lastFrame > 150) tick(now); }, 100);
  if (smoke) { void nativeSmoke(); return; }
  void refresh();if(native){syncAnalysisPending(state);void screenNews();}
  if (import.meta.env.DEV && !native) {
    Object.assign(window, { __newsFloatTest: {
      playback,openCurrentStory,aiClient:analysisClient,aiQueue:analysisQueue,controlAI,enableAI,disableAI,receiveAIPause,aiUsage:()=>aiUsage,bridge,screenNews,
      setMode, ingest, state: () => state, groups: () => groups, fingerprint: (item:NewsItem) => fingerprint(item,state.preferences), setAIStatus: (configured:boolean, error?:string) => { hasKey=configured; aiError=error; updateView(); }, follow, window: previewWindow,nativeHover:updateNativeHover,tickerPosition:()=>marquee?.position()??0,tickerDistance:()=>marqueeDistance,tickerSync:()=>marquee?.syncVisual(),tickerPhase:()=>tickerPhase,tickerCompletionDistance:()=>tickerPhase==='incoming'?marqueeDistance+(tickerCopy?.getBoundingClientRect().width??0):marqueeDistance,visibleCount:()=>visibleCount,
      add: (items: NewsItem[]) => { if(!state.items.length){tickerCurrent=tickerNext=tickerPriority=undefined;tickerOutgoing?.remove();tickerOutgoing=null;tickerID='';tickerPhase='start';marquee?.jump(0);}state.items = merge(state.items, items); scheduleAttention(); updateView(); },
    } });
  }
}
async function nativeSmoke() {
  const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
  // Owned test windows and sample data only. No credentials, caches or network calls.
  await wait(5000);
  let aiWorker=false;try{await analysisClient.sync(false);aiWorker=true;}catch{}
  const horizontal = aiWorker && !!ticker && marqueeDistance>5 && (marquee?.position()??0)>3;
  const expectedStory=groups[1]?.id;manualPage(1);await openCurrentStory();
  const clicked=root.querySelector<HTMLElement>(`article[data-id="${expectedStory}"]`);
  const storyAnchor=!!clicked?.classList.contains('story-expanded')&&!!scroller&&Math.abs(clicked.getBoundingClientRect().top-scroller.getBoundingClientRect().top)<2;
  resumeFollow();await wait(3500);
  let glanceScroll = storyAnchor && !!scroller && scroller.scrollHeight > scroller.clientHeight * 2 && scroller.scrollTop === 0;
  if (scroller) scroller.scrollTop = 200;
  state.items = merge(state.items, [{id:'jin10:native-latest',source:'jin10',title:'原生测试 · 刚到的最新消息',body:'有新消息就回到顶部，没有新消息就保持，不自动往历史滚动。',publishedAt:Date.now(),url:'',tags:[]}]);
  updateView();
  glanceScroll = glanceScroll && !!scroller && scroller.scrollTop === 0;
  await setMode('feed'); await wait(3500);
  const feedScroll = !!scroller && scroller.scrollHeight > scroller.clientHeight * 2 && scroller.scrollTop === 0;
  const noOverflow = root.scrollWidth <= root.clientWidth && root.scrollHeight <= root.clientHeight;
  const beforePin = await bridge.windowStatus();
  const defaultPinned = beforePin.pinned && (!beforePin.native || (beforePin.native.level>=25 && beforePin.native.fullScreenAuxiliary && beforePin.native.allSpaces));
  await bridge.setPinned(false); await wait(100);
  const disabled = !(await bridge.windowStatus()).pinned;
  await bridge.setPinned(true); await wait(100);
  const pinToggle = defaultPinned && disabled && (await bridge.windowStatus()).pinned;
  await setMode('compact'); await wait(100);
  let b=await bridge.windowStatus();
  await bridge.resize({x:b.x/b.scale,y:b.y/b.scale,width:430,height:34,persist:true});
  await setMode('glance'); await wait(100);b=await bridge.windowStatus();
  await bridge.resize({x:b.x/b.scale,y:b.y/b.scale,width:560,height:420,persist:true});
  await setMode('compact'); await wait(200);
  const compactRestored=innerWidth===430&&innerHeight===34;
  const compactBounds=await bridge.windowStatus();
  await setMode('glance'); await wait(200);
  const expandedRestored=innerWidth===560&&innerHeight===420;
  const expandedBounds=await bridge.windowStatus();
  await setMode('compact'); await wait(200);
  const collapse = compactRestored&&expandedRestored&&innerWidth === 430 && innerHeight === 34 && !!root.querySelector('.pill');
  await bridge.smokeReport({horizontal,glanceScroll,feedScroll,collapse,noOverflow,pinToggle,details:{storyAnchor,beforePin,compactBounds,expandedBounds,actualWidth:innerWidth,actualHeight:innerHeight}});
}
void start();
