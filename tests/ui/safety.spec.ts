import {test,expect} from '@playwright/test';
test.beforeEach(async({page})=>{await page.goto('/');await page.waitForFunction(()=>!!(window as any).__newsFloatTest);});
test('pointer paging hides after click and leave while keyboard focus remains operable',async({page})=>{
 await page.setViewportSize({width:300,height:34});await page.mouse.move(0,80);
 const next=page.getByRole('button',{name:'下一条',exact:true});await expect(next).toHaveCSS('opacity','0');
 await page.locator('.ticker').hover();await expect(next).toHaveCSS('opacity','1');await next.click();await expect(page.locator('.pill')).toBeVisible();
 await page.mouse.move(0,80);await expect(next).toHaveCSS('opacity','0');
 await next.focus();await page.keyboard.press('Shift+Tab');await expect(next).toHaveCSS('opacity','1');await page.keyboard.press('ArrowRight');await expect(page.locator('.pill')).toBeVisible();
});
test('more menu closes on pointer departure, outside click and window blur',async({page})=>{
 await page.evaluate(()=>(window as any).__newsFloatTest.setMode('feed'));const menu=page.locator('.reader-menu');
 await menu.locator('summary').click();await expect(menu).toHaveAttribute('open');await page.locator('.brand').hover();await expect(menu).not.toHaveAttribute('open');
 await menu.locator('summary').click();await page.locator('.brand').click();await expect(menu).not.toHaveAttribute('open');
 await menu.locator('summary').click();await page.evaluate(()=>window.dispatchEvent(new Event('blur')));await expect(menu).not.toHaveAttribute('open');
});
test('themes preview immediately, cancel restores appearance, save survives presentation changes',async({page})=>{
 await page.evaluate(()=>(window as any).__newsFloatTest.setMode('feed'));
 await page.evaluate(()=>(window as any).__newsFloatTest.setMode('settings'));await page.getByLabel('主题',{exact:true}).selectOption('light');await page.getByLabel('强调色',{exact:true}).selectOption('blue');
 await expect(page.locator('html')).toHaveAttribute('data-theme','light');await expect(page.locator('html')).toHaveAttribute('data-accent','blue');
 await page.getByRole('button',{name:'取消',exact:true}).click();await expect(page.locator('html')).toHaveAttribute('data-theme','dark');
 await page.getByRole('button',{name:'设置',exact:true}).click();await page.getByLabel('主题',{exact:true}).selectOption('light');await page.getByLabel('强调色',{exact:true}).selectOption('green');await page.getByRole('button',{name:'保存',exact:true}).click();await page.getByRole('button',{name:'收起',exact:true}).click();
 await expect(page.locator('html')).toHaveAttribute('data-theme','light');await expect(page.locator('html')).toHaveAttribute('data-accent','green');
 await page.evaluate(()=>(window as any).__newsFloatTest.setMode('settings'));await page.getByLabel('主题',{exact:true}).selectOption('system');await page.emulateMedia({colorScheme:'dark'});await expect(page.locator('html')).toHaveAttribute('data-theme','dark');await page.emulateMedia({colorScheme:'light'});await expect(page.locator('html')).toHaveAttribute('data-theme','light');
});
test('large feed bounds initial DOM while search covers all news and older rows load on demand',async({page})=>{
 const result=await page.evaluate(async()=>{const h=(window as any).__newsFloatTest;h.state().items=[];h.add(Array.from({length:1000},(_,i)=>({id:`cls:many-${i}`,source:'cls',title:`新闻 ${i}`,body:`第 ${i} 条独立新闻的具体数据与内容。`,publishedAt:Date.now()-i*60000,url:'',tags:[]})));const t=performance.now();await h.setMode('feed');return {elapsed:performance.now()-t,groups:h.groups().length};});
 expect(result.groups).toBe(1000);expect(result.elapsed).toBeLessThan(250);await expect(page.locator('article')).toHaveCount(40);
 await page.getByRole('button',{name:'查看更早的新闻'}).click();await expect.poll(()=>page.locator('article').count()).toBeGreaterThanOrEqual(80);
 await page.locator('.reading-tools-summary').click();await page.getByRole('searchbox').fill('新闻 999');await expect(page.locator('article')).toHaveCount(1);await expect(page.locator('article')).toContainText('新闻 999');
});
test('AI planning runs in a worker, yields to UI and preserves compact highlights',async({page})=>{
 const result=await page.evaluate(async()=>{const h=(window as any).__newsFloatTest,s=h.state();s.items=[];Object.assign(s.preferences,{aiEnabled:true,interests:'宏观',keywordEnabled:false});s.preferences.aiLimits.newOnly=false;s.preferences.aiLimits.lookbackMinutes=60;h.add(Array.from({length:1000},(_,i)=>({id:`cls:worker-${i}`,source:'cls',title:'',body:`宏观新闻${i}：经济数据和政策变化，包含具体的公开市场信息。`.repeat(10),publishedAt:Date.now()-i*1000,url:'',tags:[]})));let ticks=0;const timer=setInterval(()=>ticks++,5);const jobs=await h.aiClient.plan(true);clearInterval(timer);await h.aiClient.apply([{key:jobs[0].key,judgement:{kind:'json',relevant:true,probability:1,model:'mock',fingerprint:jobs[0].key}}],true);h.setAIStatus(true);return {ticks,jobs:jobs.length};});
 expect(result.jobs).toBe(1000);expect(result.ticks).toBeGreaterThan(0);await expect(page.locator('.ticker-copy')).toHaveClass(/matched/);
});
test('stopping AI cancels queue progression and late responses cannot annotate or trigger more requests',async({page})=>{
 await page.evaluate(async()=>{const h=(window as any).__newsFloatTest,s=h.state();s.items=[];Object.assign(s.preferences,{aiEnabled:true,aiPaused:false,interests:'科技'});s.preferences.aiLimits.newOnly=false;s.preferences.ai.batchSize=1;s.preferences.ai.concurrency=1;h.setAIStatus(true);(window as any).calls=0;h.bridge.judgeBatch=(inputs:any[])=>{(window as any).calls++;return new Promise(resolve=>{(window as any).finishAI=()=>resolve(inputs.map(i=>({id:i.item.id,judgement:{kind:'json',relevant:true,probability:1,model:'mock',fingerprint:i.fingerprint}})));});};h.add([0,1,2].map(i=>({id:`cls:stop-${i}`,source:'cls',body:`科技公司 ${i} 宣布研发产品`,title:'',publishedAt:Date.now()-i*1000,url:'',tags:[]})));h.screenNews();await h.setMode('feed');});
 await expect.poll(()=>page.evaluate(()=>(window as any).calls)).toBe(1);await page.getByRole('button',{name:'关闭 AI',exact:true}).click();await expect(page.getByRole('button',{name:'开启 AI',exact:true})).toBeVisible();expect(await page.evaluate(()=>(window as any).__newsFloatTest.state().preferences.aiEnabled)).toBe(false);
 await page.evaluate(()=>(window as any).finishAI());await page.waitForTimeout(400);expect(await page.evaluate(()=>(window as any).calls)).toBe(1);expect(await page.evaluate(()=>(window as any).__newsFloatTest.state().items.some((i:any)=>i.judgement))).toBe(false);
 await page.getByRole('button',{name:'收起',exact:true}).click();await page.keyboard.press('Control+Shift+k');expect(await page.evaluate(()=>(window as any).__newsFloatTest.state().preferences.aiPaused)).toBe(true);
});
test('AI scope and quotas save with no automatic retry, and an external stop survives a settings save',async({page})=>{
 await page.evaluate(()=>(window as any).__newsFloatTest.setMode('settings'));await page.getByLabel('用 AI 标记感兴趣的新闻').check();await page.getByLabel('我关注什么',{exact:true}).fill('科技');await page.locator('.ai-safety > summary').click();
 await expect(page.getByLabel('只判断开启后发布或更正的新闻')).toBeChecked();await page.getByLabel('只判断最近',{exact:true}).selectOption('60');await page.locator('.daily-budget > summary').click();await expect(page.getByLabel('启用每日硬额度')).not.toBeChecked();await page.getByLabel('启用每日硬额度').check();await page.getByLabel('24 小时最多判断（条）').fill('20');await page.getByLabel('24 小时最多请求（次）').fill('5');
 await page.evaluate(()=>{const h=(window as any).__newsFloatTest;h.bridge.keyStatus=()=>new Promise(resolve=>(window as any).finishKeyStatus=()=>resolve(false));const original=h.bridge.setAIPaused;(window as any).resumeCalls=0;h.bridge.setAIPaused=(paused:boolean,...args:any[])=>{if(!paused)(window as any).resumeCalls++;return original(paused,...args);};});
 await page.getByRole('button',{name:'保存',exact:true}).click();await page.waitForFunction(()=>!!(window as any).finishKeyStatus);
 await page.evaluate(()=>{const h=(window as any).__newsFloatTest;h.receiveAIPause({paused:true,enabled:false,startedAt:Date.now(),generation:1});(window as any).finishKeyStatus();});await expect(page.locator('.pill')).toBeVisible();expect(await page.evaluate(()=>(window as any).resumeCalls)).toBe(0);
 const prefs=await page.evaluate(()=>(window as any).__newsFloatTest.state().preferences);expect(prefs.aiPaused).toBe(true);expect(prefs.aiEnabled).toBe(false);expect(prefs.aiLimits).toMatchObject({lookbackMinutes:60,maxItems24h:20,maxRequests24h:5,maxRetries:0});
});

test('reading speed adjusts continuously, can reset, and persists without enabling AI',async({page})=>{
 await page.evaluate(()=>(window as any).__newsFloatTest.setMode('settings'));const slider=page.getByRole('slider',{name:'阅读速度'});await slider.fill('47');await expect(page.locator('.speed-output')).toHaveText('2.1×');await page.getByRole('button',{name:'恢复默认速度'}).click();await expect(slider).toHaveValue('22');await slider.fill('37');await page.getByRole('button',{name:'保存',exact:true}).click();
 expect(await page.evaluate(()=>(window as any).__newsFloatTest.state().preferences.scrollSpeed)).toBe(37);await page.evaluate(()=>(window as any).__newsFloatTest.setMode('settings'));await expect(page.getByRole('slider',{name:'阅读速度'})).toHaveValue('37');await page.getByRole('slider',{name:'阅读速度'}).fill('60');await page.getByRole('button',{name:'取消',exact:true}).click();expect(await page.evaluate(()=>(window as any).__newsFloatTest.state().preferences.scrollSpeed)).toBe(37);
});
test('AI defaults to continuous pacing and changing its rate keeps the original news cutoff',async({page})=>{
 await page.evaluate(()=>{const h=(window as any).__newsFloatTest,s=h.state();Object.assign(s.preferences,{aiEnabled:true,aiPaused:false,aiStartedAt:Date.now()-10000,interests:'科技'});(window as any).originalCutoff=s.preferences.aiStartedAt;return h.setMode('settings');});
 await expect(page.getByLabel('窗口内最多请求（次）')).toHaveValue('6');await expect(page.getByLabel('24 小时最多请求（次）')).toBeHidden();await page.getByLabel('窗口内最多请求（次）').fill('12');await page.getByRole('button',{name:'保存',exact:true}).click();
 const result=await page.evaluate(()=>{const s=(window as any).__newsFloatTest.state();return {limits:s.preferences.aiLimits,cutoff:s.preferences.aiStartedAt,original:(window as any).originalCutoff};});expect(result.limits.dailyEnabled).toBe(false);expect(result.limits.maxRequestsPerMinute).toBe(12);expect(result.cutoff).toBe(result.original);
});

test('saved reading speed controls the actual marquee distance over time',async({page})=>{
 await page.clock.install();await page.setViewportSize({width:300,height:34});await page.evaluate(()=>(window as any).__newsFloatTest.setMode('settings'));await page.getByRole('slider',{name:'阅读速度'}).fill('37');await page.getByRole('button',{name:'保存',exact:true}).click();await expect(page.locator('.pill')).toBeVisible();await page.mouse.move(0,80);await page.clock.runFor(3300);const before=await page.evaluate(()=>(window as any).__newsFloatTest.tickerPosition());await page.clock.runFor(1000);const after=await page.evaluate(()=>(window as any).__newsFloatTest.tickerPosition());expect(after-before).toBeGreaterThan(36);expect(after-before).toBeLessThan(38);
});

test('ordinary settings never touch credential storage or trigger source fetches with AI off or running',async({page})=>{
  for(const enabled of [false,true]){
    await page.evaluate(enabled=>{const h=(window as any).__newsFloatTest,s=h.state();s.preferences.aiEnabled=enabled;s.preferences.aiPaused=!enabled;h.setAIStatus(enabled);(window as any).credentialCalls=0;(window as any).refreshCalls=0;h.bridge.keyStatus=async()=>{(window as any).credentialCalls++;throw Error('Ordinary settings accessed credentials');};h.bridge.saveKey=async()=>{(window as any).credentialCalls++;};h.bridge.saveSourceKey=async()=>{(window as any).credentialCalls++;};h.bridge.refresh=async()=>{(window as any).refreshCalls++;return [];};return h.setMode('settings');},enabled);
    await page.getByRole('slider',{name:'阅读速度'}).fill(enabled?'40':'30');
    await page.getByRole('button',{name:'保存',exact:true}).click();await expect(page.locator('.settings')).toHaveCount(0);
    expect(await page.evaluate(()=>(window as any).credentialCalls)).toBe(0);expect(await page.evaluate(()=>(window as any).refreshCalls)).toBe(0);
    expect(await page.evaluate(()=>(window as any).__newsFloatTest.state().preferences.aiEnabled)).toBe(enabled);
  }
});

test('AI safety actions keep visible text, tooltips and accessible names consistent after toggling',async({page})=>{
  await page.evaluate(()=>{const h=(window as any).__newsFloatTest,s=h.state();s.preferences.aiEnabled=true;s.preferences.aiPaused=false;h.setAIStatus(true);return h.setMode('settings');});
  const control=page.locator('.ai-safety-control');
  await expect(control).toHaveAccessibleName('立即停止 AI');await control.click();
  await expect(control).toHaveText('继续 AI 判断');await expect(control).toHaveAccessibleName('继续 AI 判断');await expect(control).toHaveAttribute('title','继续 AI 判断');
});
