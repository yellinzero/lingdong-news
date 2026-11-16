import {readFileSync} from 'node:fs';
import { test, expect, type Page } from '@playwright/test';
const pageErrors = new WeakMap<Page, string[]>();
test.afterEach(async ({page}) => { expect(pageErrors.get(page) ?? [], 'Unexpected browser errors').toEqual([]); });
test.beforeEach(async ({page}) => { const errors: string[] = []; pageErrors.set(page, errors); page.on('pageerror', error => errors.push(error.stack ?? error.message)); await page.goto('/'); await page.waitForFunction(() => !!(window as any).__newsFloatTest); });
test('compact full text scrolls horizontally, pauses on hover, accepts horizontal wheel', async ({page}) => {
  await page.setViewportSize({width:300,height:34}); await page.mouse.move(0,100);
  const ticker = page.locator('.ticker');
  await expect.poll(() => ticker.evaluate(e => e.scrollWidth - e.clientWidth)).toBeGreaterThan(200);
  await expect.poll(() => page.evaluate(()=>(window as any).__newsFloatTest.tickerPosition()), {timeout:8000}).toBeGreaterThan(15);
  await ticker.hover(); const position = await page.evaluate(()=>(window as any).__newsFloatTest.tickerPosition());
  await page.waitForTimeout(500); expect(await page.evaluate(()=>(window as any).__newsFloatTest.tickerPosition())).toBeCloseTo(position, 0);
  await page.mouse.wheel(90,0); await expect.poll(() => page.evaluate(()=>(window as any).__newsFloatTest.tickerPosition())).toBeGreaterThan(position+30);
  await expect(page.locator('.ticker-copy')).not.toHaveCSS('text-overflow','ellipsis');
});
test('expanded views stay on latest, never drift into history, and jump to actual new arrivals even on hover', async ({page}) => {
  await page.clock.install();
  for (const mode of ['glance','feed']) {
    await page.evaluate(m => (window as any).__newsFloatTest.setMode(m),mode);
    await page.mouse.move(0,800);
    const scroll = page.locator('.news-scroll');
    await expect.poll(() => scroll.evaluate(e => e.scrollHeight-e.clientHeight)).toBeGreaterThan(800);
    await page.clock.runFor(20_000);
    expect(await scroll.evaluate(e => e.scrollTop)).toBe(0);
    await scroll.hover(); await page.mouse.wheel(0,600);
    await expect.poll(() => scroll.evaluate(e => e.scrollTop)).toBeGreaterThan(200);
    await expect(page.getByRole('button',{name:'回到最新',exact:true})).toContainText('阅读历史');
    const readingPosition=await scroll.evaluate(e=>e.scrollTop);
    await page.mouse.move(0,800); await page.clock.runFor(20_000);
    expect(await scroll.evaluate(e=>e.scrollTop)).toBe(readingPosition);
    // Incoming latest news wins even if the pointer is over the expanded panel.
    await scroll.hover();
    await page.evaluate(m => { const hook=(window as any).__newsFloatTest; hook.add([{id:`jin10:live-${m}`,source:'jin10',title:`最新消息 ${m}`,body:'新消息完整正文',publishedAt:Date.now(),url:'',important:false}]); },mode);
    await expect(page.locator('article').first()).toContainText(`最新消息 ${mode}`);
    await expect.poll(() => scroll.evaluate(e => e.scrollTop)).toBe(0);
    await page.clock.runFor(20_000); expect(await scroll.evaluate(e=>e.scrollTop)).toBe(0);
  }
});
test('turning off automatic latest preserves manual reading anchor and text selection', async ({page}) => {
  await page.evaluate(() => (window as any).__newsFloatTest.setMode('feed'));
  await page.getByRole('button',{name:'设置',exact:true}).click();
  await page.getByLabel('自动展示最新').uncheck();
  await page.getByRole('button',{name:'保存',exact:true}).click();
  const scroll=page.locator('.news-scroll'); await scroll.hover(); await page.mouse.wheel(0,700);
  await expect.poll(() => scroll.evaluate(e => e.scrollTop)).toBeGreaterThan(500);
  const anchor=await scroll.evaluate(e => {
    const r=[...e.querySelectorAll<HTMLElement>('article')].find(n=>n.offsetTop+n.offsetHeight>=e.scrollTop)!;
    return {id:r.dataset.id,offset:r.offsetTop-e.scrollTop};
  });
  await page.evaluate(() => {
    const hook=(window as any).__newsFloatTest;
    hook.add([{id:'jin10:brand-new',source:'jin10',title:'刚刚到达的新快讯',body:'新消息完整正文',publishedAt:Date.now()+1000,url:'',important:false}]);
  });
  expect(await scroll.evaluate((e,id) => e.querySelector<HTMLElement>(`article[data-id="${id}"]`)!.offsetTop-e.scrollTop,anchor.id)).toBeCloseTo(anchor.offset,0);
  await page.getByRole('button',{name:'回到最新',exact:true}).click();
  await expect(page.locator('article').first()).toContainText('刚刚到达的新快讯');
  await expect.poll(() => scroll.evaluate(e=>e.scrollTop)).toBe(0);
  const body=page.locator('article .news-body').nth(1);
  await body.evaluate(e=>{const range=document.createRange();range.selectNodeContents(e);window.getSelection()!.removeAllRanges();window.getSelection()!.addRange(range);});
  const selected=await page.evaluate(()=>window.getSelection()?.toString());
  await page.evaluate(()=>{const hook=(window as any).__newsFloatTest;hook.add(hook.state().items);});
  expect(await page.evaluate(()=>window.getSelection()?.toString())).toBe(selected);
});
test('compact reads latest first, advances only after finishing, keeps next on unchanged refresh and preempts on new news', async ({page}) => {
  await page.setViewportSize({width:300,height:34}); await page.mouse.move(0,100); await page.clock.install();
  await page.evaluate(()=> {
    const hook=(window as any).__newsFloatTest, now=Date.now();
    hook.state().items=[]; hook.state().preferences.scrollSpeed=100;
    hook.add(['最新第一条','次新第二条','第三条'].map((title,index)=>({id:`cls:carousel-${index}`,source:'cls',title,body:(title+'的完整正文。').repeat(8),publishedAt:now-index*60000,url:'',important:false})));
  });
  await expect(page.locator('.ticker-copy')).toContainText('最新第一条');
  const distance=await page.evaluate(()=>(window as any).__newsFloatTest.tickerDistance());
  await page.clock.runFor(2100); await expect(page.locator('.ticker-copy')).toContainText('最新第一条');
  await page.clock.runFor(Math.ceil(distance*10)+200); await expect(page.locator('.ticker-copy')).toContainText('次新第二条');
  // Next news is already moving: no tail hold or second start delay.
  expect(await page.evaluate(()=>(window as any).__newsFloatTest.tickerPosition())).toBeGreaterThan(0);
  // Polling the same news again must not restart at index zero.
  await page.evaluate(()=>{const hook=(window as any).__newsFloatTest;hook.add(hook.state().items);});
  await expect(page.locator('.ticker-copy')).toContainText('次新第二条');
  await page.evaluate(()=>{(window as any).__newsFloatTest.add([{id:'jin10:breaking',source:'jin10',title:'刚刷新的最新一条',body:'立即优先展示。'.repeat(20),publishedAt:Date.now()+1000,url:'',important:false}]);});
  await expect(page.locator('.ticker-copy')).toContainText('次新第二条');
  await expect(page.locator('.ticker-upcoming')).toContainText('刚刷新的最新一条');
});
test('expanded layout stays within viewport after resize, wheel never scrolls fixed header', async ({page}) => {
  await page.evaluate(()=>(window as any).__newsFloatTest.setMode('feed'));
  for (const size of [{width:360,height:430},{width:1000,height:900},{width:480,height:700}]) {
    await page.setViewportSize(size); const scroll=page.locator('.news-scroll');
    await scroll.hover(); await page.mouse.wheel(0,1500);
    await expect.poll(()=>scroll.evaluate(e=>e.scrollTop)).toBeGreaterThan(10);
    const header=await page.locator('.panel-header').boundingBox(); expect(header!.y).toBeLessThan(3);
    const root=await page.locator('#app').evaluate(e=>({x:e.scrollWidth>e.clientWidth,y:e.scrollHeight>e.clientHeight}));
    expect(root).toEqual({x:false,y:false});
    await expect(page.getByRole('button',{name:'收起',exact:true})).toBeVisible();
  }
});
test('collapse always works from settings, expanded feed, and compact preview', async ({page}) => {
  for(const mode of ['glance','feed','settings','feed','glance']) {
    await page.evaluate(m=>(window as any).__newsFloatTest.setMode(m),mode);
    await page.getByRole('button',{name:'收起',exact:true}).click(); await expect(page.locator('.pill')).toBeVisible();
    await page.locator('.ticker').click(); await expect(page.locator('.glance')).toBeVisible();
  }
});
test('no error for unconfigured JEV; default controls disabled; settings survive shell changes', async ({page}) => {
  await page.evaluate(async()=>{const h=(window as any).__newsFloatTest;await h.setMode('feed');await h.setMode('settings');});
  await expect(page.getByLabel('关键词高亮')).not.toBeChecked();
  await expect(page.getByLabel('用 AI 标记感兴趣的新闻')).not.toBeChecked();
  await page.getByLabel('用 AI 标记感兴趣的新闻').check();
  await page.getByRole('button',{name:'保存',exact:true}).click();
  await expect(page.locator('.reading-tools')).not.toHaveAttribute('open');
  await page.locator('.reading-tools-summary').click();
  await expect(page.locator('.filter-label')).toHaveText('原始消息流');
  await expect(page.locator('.status-button')).not.toContainText('项状态');
});
test('feed search does not hide or stop the compact live ticker', async ({page}) => {
  await page.evaluate(()=>(window as any).__newsFloatTest.setMode('feed'));
  await page.locator('.reading-tools-summary').click();
  await page.getByRole('searchbox',{name:'搜索快讯'}).fill('没有匹配项的搜索词');
  await expect(page.locator('article')).toHaveCount(0);
  await page.getByRole('button',{name:'收起',exact:true}).click();
  await page.setViewportSize({width:300,height:34}); await page.mouse.move(0,100);
  await expect(page.locator('.ticker-copy')).toContainText('界面预览 1');
  await expect.poll(()=>page.evaluate(()=>(window as any).__newsFloatTest.tickerPosition()),{timeout:8000}).toBeGreaterThan(10);
});
test('credential deletion is staged until Save and does not submit the form', async ({page}) => {
  await page.evaluate(async()=>{const h=(window as any).__newsFloatTest;await h.setMode('feed');await h.setMode('settings');});
  await page.getByText('连接 AI 模型',{exact:true}).click();
  await page.getByRole('button',{name:'删除此地址已保存的 Key'}).click();
  await expect(page.locator('.settings-scroll')).toBeVisible();
  await expect(page.getByLabel('API Key（仅保存在系统凭据库）')).toHaveAttribute('placeholder','保存设置后删除 Key');
});
test('title and top bar drag, buttons do not start dragging', async ({page}) => {
  await page.evaluate(()=>(window as any).__newsFloatTest.setMode('feed'));
  for (const selector of ['.brand','.panel-header > .spacer']) {
    await page.locator(selector).first().dispatchEvent('mousedown',{button:0});
  }
  expect(await page.evaluate(()=>(window as any).__newsFloatTest.window.dragRequests)).toBe(2);
  await page.getByRole('button',{name:'设置',exact:true}).dispatchEvent('mousedown',{button:0});
  await page.getByRole('button',{name:'已置顶 · 点击取消置顶'}).dispatchEvent('mousedown',{button:0});
  expect(await page.evaluate(()=>(window as any).__newsFloatTest.window.dragRequests)).toBe(2);
  await page.getByRole('button',{name:'收起',exact:true}).click();
  await page.setViewportSize({width:300,height:34});
  await page.mouse.move(100,17);await page.mouse.down();await page.mouse.move(140,17,{steps:5});await page.mouse.up();
  expect(await page.evaluate(()=>(window as any).__newsFloatTest.window.dragRequests)).toBe(3);
  await expect(page.locator('.pill')).toBeVisible();
});
test('compact is news-only and supports manual next by hover button and right arrow', async ({page}) => {
  await page.setViewportSize({width:300,height:34});
  await page.mouse.move(0,100);
  await expect(page.locator('.pill-count,.drag-dot,.pill-separator,#pill-warning')).toHaveCount(0);
  await expect(page.locator('.ticker-next')).toHaveCSS('opacity','0');
  await expect(page.locator('.ticker-copy')).toContainText('界面预览 1');
  await page.locator('.pill').hover(); await page.getByRole('button',{name:'下一条',exact:true}).click();
  await expect(page.locator('.ticker-copy')).toContainText('界面预览 2');
  await expect(page.locator('.pill')).toBeVisible();
  await page.locator('.ticker').focus(); await page.keyboard.press('ArrowRight');
  await expect(page.locator('.ticker-copy')).toContainText('界面预览 3');
  expect(await page.evaluate(()=>(window as any).__newsFloatTest.tickerPosition())).toBe(0);
});
test('native hover reveals both pager buttons without focusing or clicking, and arrow clicks never expand',async({page})=>{
  await page.setViewportSize({width:300,height:34});await page.mouse.move(0,100);
  expect(await page.evaluate(()=>document.activeElement===document.body)).toBe(true);
  await expect(page.locator('.ticker-previous')).toHaveCSS('opacity','0');
  await expect(page.locator('.ticker-next')).toHaveCSS('opacity','0');
  await page.evaluate(()=>(window as any).__newsFloatTest.nativeHover(true));
  await expect(page.locator('.ticker-previous')).toHaveCSS('opacity','1');
  await expect(page.locator('.ticker-next')).toHaveCSS('opacity','1');
  expect(await page.evaluate(()=>document.activeElement===document.body)).toBe(true);
  const pagerHit=await page.evaluate(()=>document.elementFromPoint(282,17)?.getAttribute('aria-label'));
  expect(pagerHit).toBe('下一条');
  await page.getByRole('button',{name:'下一条',exact:true}).click();
  await expect(page.locator('.ticker-copy')).toContainText('界面预览 2');await expect(page.locator('.pill')).toBeVisible();
  await page.getByRole('button',{name:'上一条',exact:true}).click();
  await expect(page.locator('.ticker-copy')).toContainText('界面预览 1');await expect(page.locator('.pill')).toBeVisible();
});
test('first click in a not-yet-painted inactive pager area pages instead of expanding',async({page})=>{
  await page.setViewportSize({width:300,height:34});await page.mouse.move(0,100);
  await page.locator('.pill').dispatchEvent('click',{clientX:282,clientY:17});
  await expect(page.locator('.ticker-copy')).toContainText('界面预览 2');await expect(page.locator('.pill')).toBeVisible();
  await page.locator('.pill').dispatchEvent('click',{clientX:256,clientY:17});
  await expect(page.locator('.ticker-copy')).toContainText('界面预览 1');await expect(page.locator('.pill')).toBeVisible();
});
test('whole compact text is draggable, while a click expands and pager buttons do not drag',async({page})=>{
  await page.setViewportSize({width:300,height:34});
  // WebKit can finish resizing its viewport before the composited hit-test surface catches up.
  // Locator hover waits for stable geometry before starting each real mouse gesture.
  for(const x of [12,95,205]){await page.locator('.pill').hover({position:{x,y:17}});await page.mouse.down();await page.mouse.move(x+25,20,{steps:5});await page.mouse.up();await expect(page.locator('.pill')).toBeVisible();}
  expect(await page.evaluate(()=>(window as any).__newsFloatTest.window.dragRequests)).toBe(3);
  await page.getByRole('button',{name:'下一条',exact:true}).click();
  await page.getByRole('button',{name:'上一条',exact:true}).click();
  expect(await page.evaluate(()=>(window as any).__newsFloatTest.window.dragRequests)).toBe(3);
  await page.locator('.ticker').click();await expect(page.locator('.glance')).toBeVisible();
});
test('manual previous/next resumes scrolling after a short delay even while hovered, then advances; new arrivals win',async({page})=>{
  await page.setViewportSize({width:300,height:34});await page.clock.install();await page.locator('.pill').hover();
  await page.getByRole('button',{name:'下一条',exact:true}).click();
  await expect(page.locator('.ticker-copy')).toContainText('界面预览 2');
  await page.clock.runFor(2100);expect(await page.evaluate(()=>(window as any).__newsFloatTest.tickerPosition())).toBe(0);
  await page.clock.runFor(1200);expect(await page.evaluate(()=>(window as any).__newsFloatTest.tickerPosition())).toBeGreaterThan(10);
  const remaining=await page.evaluate(()=>(window as any).__newsFloatTest.tickerDistance()-(window as any).__newsFloatTest.tickerPosition());
  await page.evaluate(()=>(window as any).__newsFloatTest.state().preferences.scrollSpeed=100);
  await page.clock.runFor(Math.ceil(remaining*10)+100);
  await page.evaluate(()=>(window as any).__newsFloatTest.state().preferences.scrollSpeed=22);await expect(page.locator('.ticker-copy')).toContainText('界面预览 3');
  await page.getByRole('button',{name:'上一条',exact:true}).click();await expect(page.locator('.ticker-copy')).toContainText('界面预览 2');
  await page.locator('.ticker').focus();await page.keyboard.press('ArrowLeft');await expect(page.locator('.ticker-copy')).toContainText('界面预览 1');
  await page.keyboard.press('ArrowRight');await expect(page.locator('.ticker-copy')).toContainText('界面预览 2');
  await page.evaluate(()=>(window as any).__newsFloatTest.add([{id:'cls:pager-new',source:'cls',title:'翻页时刚到的最新新闻',body:'完整正文',publishedAt:Date.now(),url:'',important:false}]));
  await expect(page.locator('.ticker-copy')).toContainText('界面预览 2');
  await expect(page.locator('.ticker-upcoming')).toContainText('翻页时刚到的最新新闻');
});
test('resize edges persist compact width and expanded dimensions separately',async({page})=>{
  await page.setViewportSize({width:300,height:34});
  await page.locator('.resize-e').hover();
  await page.mouse.move(298,17);await page.mouse.down();await page.mouse.move(238,17,{steps:5});await page.mouse.up();
  await expect.poll(()=>page.evaluate(()=>(window as any).__newsFloatTest.window.width)).toBe(240);
  expect(await page.evaluate(()=>(window as any).__newsFloatTest.window.height)).toBe(34);
  await page.locator('.ticker').click();await page.setViewportSize({width:380,height:320});
  await page.locator('.resize-se').hover();
  await page.mouse.move(374,314);await page.mouse.down();await page.mouse.move(334,274,{steps:5});await page.mouse.up();
  await expect.poll(()=>page.evaluate(()=>(window as any).__newsFloatTest.window.width)).toBe(340);
  expect(await page.evaluate(()=>(window as any).__newsFloatTest.window.height)).toBe(280);
  await page.getByRole('button',{name:'收起',exact:true}).click();
  expect(await page.evaluate(()=>(window as any).__newsFloatTest.window.width)).toBe(240);
  await page.locator('.ticker').click();
  expect(await page.evaluate(()=>(window as any).__newsFloatTest.window.width)).toBe(340);
  expect(await page.evaluate(()=>(window as any).__newsFloatTest.window.height)).toBe(280);
});
test('pin defaults on, clearly toggles off and on, persists across presentation changes', async ({page}) => {
  await page.evaluate(()=>(window as any).__newsFloatTest.setMode('feed'));
  const pin=page.locator('[data-pin-toggle]'); await expect(pin).toHaveAttribute('aria-pressed','true');
  await pin.click(); await expect(pin).toHaveAttribute('aria-pressed','false'); await expect(pin).toHaveAccessibleName('未置顶 · 点击置顶');
  expect(await page.evaluate(()=>(window as any).__newsFloatTest.window.pinned)).toBe(false);
  await page.getByRole('button',{name:'收起',exact:true}).click(); await page.locator('.ticker').click();
  await expect(page.locator('[data-pin-toggle]')).toHaveAttribute('aria-pressed','false');
  await page.getByRole('button',{name:'未置顶 · 点击置顶'}).click();
  await expect(page.locator('[data-pin-toggle]')).toHaveAttribute('aria-pressed','true');
  await page.getByRole('button',{name:'设置',exact:true}).click();
  await expect(page.getByLabel('窗口置顶')).toBeChecked();
});


test('search explains no results, clears without leaving the feed, and supports the find shortcut', async ({page}) => {
  await page.evaluate(()=>(window as any).__newsFloatTest.setMode('glance'));
  await page.keyboard.press('Control+f');
  const input = page.getByRole('searchbox',{name:'搜索快讯'});
  await expect(input).toBeFocused();
  await input.fill('不可能匹配的消息');
  await expect(page.locator('article')).toHaveCount(0);
  await expect(page.locator('.empty')).toContainText('没有找到相关快讯');
  await page.locator('.search-clear').click();
  await expect(input).toHaveValue(''); await expect(input).toBeFocused();
  await expect(page.locator('article').first()).toBeVisible();
  await expect(page.locator('.search-clear')).toBeHidden();
  await input.fill('不可能匹配的消息');
  await page.locator('.empty-action').click();
  await expect(input).toHaveValue(''); await expect(page.locator('.feed')).toBeVisible();
});

test('source filtering exposes selection and a source-specific empty state', async ({page}) => {
  await page.evaluate(()=>(window as any).__newsFloatTest.setMode('feed'));
  await page.locator('.reading-tools-summary').click();
  const chips = page.getByRole('group',{name:'筛选消息来源'});
  await expect(chips.getByRole('button',{name:'全部',exact:true})).toHaveAttribute('aria-pressed','true');
  await chips.getByRole('button',{name:'金十',exact:true}).click();
  await expect(chips.getByRole('button',{name:'金十',exact:true})).toHaveAttribute('aria-pressed','true');
  await expect(chips.getByRole('button',{name:'全部',exact:true})).toHaveAttribute('aria-pressed','false');
  await expect(page.locator('.empty')).toContainText('此来源暂无快讯');
  await chips.getByRole('button',{name:'全部',exact:true}).click();
  await expect(page.locator('article').first()).toBeVisible();
});

test('optional settings disclose AI configuration and retain keyword terms across toggles', async ({page}) => {
  await page.evaluate(async()=>{const h=(window as any).__newsFloatTest;await h.setMode('feed');await h.setMode('settings');});
  await expect(page.getByLabel('模型名称')).toBeHidden();
  const terms = page.getByLabel('关注词（逗号或换行分隔）');
  await expect(terms).toBeDisabled();
  await page.getByLabel('关键词高亮',{exact:true}).check();
  await terms.fill('人工智能');
  await page.getByLabel('关键词高亮',{exact:true}).uncheck(); await expect(terms).toBeDisabled();
  await page.getByLabel('关键词高亮',{exact:true}).check(); await expect(terms).toHaveValue('人工智能');
  await page.getByLabel('用 AI 标记感兴趣的新闻',{exact:true}).check();
  await expect(page.getByLabel('模型名称')).toBeVisible();
  await page.getByLabel('模型名称').fill('example-model');
  await page.getByRole('button',{name:'取消',exact:true}).click();
  expect(await page.evaluate(()=>(window as any).__newsFloatTest.state().preferences.keywordEnabled)).toBe(false);
});

test('minimum window sizes preserve usable chrome and scrollable settings', async ({page}) => {
  await page.setViewportSize({width:320,height:220});
  for(const mode of ['glance','feed','settings']) {
    await page.evaluate(m=>(window as any).__newsFloatTest.setMode(m),mode);
    await expect(page.getByRole('button',{name:'收起',exact:true})).toBeInViewport();
    if(mode==='settings') await expect(page.getByRole('button',{name:'保存',exact:true})).toBeInViewport();
    const overflow=await page.locator('.panel-header').evaluate(e=>e.scrollWidth>e.clientWidth);
    expect(overflow).toBe(false);
    const body=page.locator(mode==='settings'?'.settings-scroll':'.news-scroll');
    expect(await body.evaluate(e=>e.clientHeight)).toBeGreaterThan(50);
  }
});


test('settings validation remains visible in a small window for an incomplete new channel', async ({page}) => {
  await page.setViewportSize({width:320,height:220});
  await page.evaluate(async()=>{const h=(window as any).__newsFloatTest;await h.setMode('feed');await h.setMode('settings');});
  await page.getByText('添加新闻来源',{exact:true}).click();await page.getByRole('button',{name:'添加来源',exact:true}).click();
  await page.getByRole('button',{name:'保存',exact:true}).click();
  await expect(page.getByRole('alert')).toContainText('请填写来源名称');
  await expect(page.getByRole('alert')).toBeInViewport();
  expect(await page.evaluate(()=>(window as any).__newsFloatTest.state().preferences.customSources.length)).toBe(0);
});

test('keyword highlighting preserves the whole stream and follows unmatched latest news in compact and expanded views',async({page})=>{
  await page.clock.install();
  await page.evaluate(()=>{
    const hook=(window as any).__newsFloatTest;
    hook.state().items=[]; hook.state().unread=[];
    hook.add(['普通最新新闻：日本公布最新贸易统计数据。','关注新闻：英伟达公布新款芯片的供货计划。','普通历史新闻：欧洲航空公司更新航线安排。'].map((body,i)=>({id:`cls:highlight-${i}`,source:'cls',title:'',body,publishedAt:Date.now()-i*60000,url:'',important:false})));
  });
  await page.evaluate(async()=>{const h=(window as any).__newsFloatTest;await h.setMode('feed');await h.setMode('settings');});
  await page.getByLabel('关键词高亮',{exact:true}).check();
  await page.getByLabel('关注词（逗号或换行分隔）').fill('英伟达');
  await page.getByRole('button',{name:'保存',exact:true}).click();
  await expect(page.locator('article')).toHaveCount(3);
  await expect(page.locator('article.matched')).toHaveCount(1);
  await expect(page.locator('article').first()).not.toHaveClass(/matched/);
  await expect(page.locator('article.matched .news-body')).toHaveCSS('color','rgb(243, 151, 109)');
  await expect(page.locator('article.matched .news-body')).toHaveCSS('font-weight','500');
  await page.getByRole('button',{name:'收起',exact:true}).click();
  await page.setViewportSize({width:300,height:34});
  await expect(page.locator('.ticker-copy')).toContainText('普通最新新闻');
  await expect(page.locator('.ticker-copy')).not.toHaveClass(/matched/);
  await page.locator('.ticker').focus(); await page.keyboard.press('ArrowRight');
  await expect(page.locator('.ticker-copy')).toContainText('英伟达');
  await expect(page.locator('.ticker-copy')).toHaveCSS('color','rgb(243, 151, 109)');
  await page.evaluate(()=>(window as any).__newsFloatTest.add([{id:'jin10:unmatched-new',source:'jin10',title:'未命中的刚到快讯',body:'天气部门发布降雨预报。',publishedAt:Date.now()+1000,url:'',important:false}]));
  await expect(page.locator('.ticker-copy')).toContainText('英伟达');
  await expect(page.locator('.ticker-upcoming')).toContainText('未命中的刚到快讯');
  await expect(page.locator('.ticker-upcoming')).not.toHaveClass(/matched/);
  await page.mouse.move(0,100);const distance=await page.evaluate(()=>(window as any).__newsFloatTest.tickerDistance());await page.clock.runFor(2500+Math.ceil(distance/22*1000));
  await expect(page.locator('.ticker-copy')).toContainText('未命中的刚到快讯');await expect(page.locator('.ticker-copy')).not.toHaveClass(/matched/);
});
test('AI annotates above-threshold results without hiding negative, pending or failed news; keywords work independently',async({page})=>{
  await page.clock.install();
  await page.evaluate(()=>{
    const hook=(window as any).__newsFloatTest, state=hook.state();
    state.items=[];state.unread=[];
    Object.assign(state.preferences,{aiEnabled:true,interests:'半导体供应',keywordEnabled:true,keywords:'黄金'});
    const items=['等待模型判断的最新新闻：欧洲议会审议交通法规。','未命中新闻：海运公司宣布调整港口服务。','模型命中新闻：半导体工厂宣布新增晶圆产能。','关键词命中新闻：黄金期货价格刷新纪录。'].map((body,i)=>({id:`cls:ai-highlight-${i}`,source:'cls',title:'',body,publishedAt:Date.now()-i*60000,url:'',important:false}));
    for(const [i,p] of [[1,0.1],[2,0.95]])Object.assign(items[i],{judgement:{probability:p,model:'test',fingerprint:hook.fingerprint(items[i])}});
    hook.add(items);hook.setAIStatus(true);
    return hook.setMode('feed');
  });
  await expect(page.locator('article')).toHaveCount(4);
  await expect(page.locator('article.matched')).toHaveCount(2);
  await expect(page.locator('article').first()).toContainText('等待模型判断');
  await expect(page.locator('.badge').filter({hasText:'JEV 95%'})).toHaveCount(1);
  await expect(page.locator('.badge').filter({hasText:'JEV 10%'})).toHaveCount(0);
  await page.evaluate(()=>(window as any).__newsFloatTest.setMode('compact'));
  await page.locator('.ticker').focus();await page.keyboard.press('ArrowRight');await page.keyboard.press('ArrowRight');
  await expect(page.locator('.ticker-copy')).toContainText('半导体工厂');
  await expect(page.locator('.ticker-copy')).toHaveClass(/matched/);
  await page.evaluate(()=>(window as any).__newsFloatTest.setAIStatus(true,'测试：连接超时'));
  await expect(page.locator('.ticker-copy')).toHaveClass(/matched/);
  await page.keyboard.press('ArrowRight');await expect(page.locator('.ticker-copy')).toContainText('黄金');
  await expect(page.locator('.ticker-copy')).toHaveClass(/matched/);
  await page.evaluate(()=>(window as any).__newsFloatTest.setMode('feed'));
  await expect(page.locator('article')).toHaveCount(4);await expect(page.locator('article.matched')).toHaveCount(2);
  await page.evaluate(()=>{const h=(window as any).__newsFloatTest;h.state().preferences.keywordEnabled=false;h.state().preferences.aiEnabled=false;h.setAIStatus(false);});
  await expect(page.locator('article')).toHaveCount(4);await expect(page.locator('article.matched')).toHaveCount(1);
});

test('custom news sources save independently, render source tags separately from keyword hits, and remove source-importance UI',async({page})=>{
  await page.clock.install();await page.evaluate(async()=>{const h=(window as any).__newsFloatTest;await h.setMode('feed');await h.setMode('settings');});
  await page.getByText('添加新闻来源',{exact:true}).click();await page.getByRole('button',{name:'添加来源',exact:true}).click();
  const source=page.getByRole('region',{name:'自定义来源',exact:true});
  await source.getByLabel('来源名称',{exact:true}).fill('个人聚合');await source.getByLabel('订阅或接口 URL',{exact:true}).fill('http://127.0.0.1:8765/news');
  await page.getByLabel('关键词高亮',{exact:true}).check();await page.getByLabel('关注词（逗号或换行分隔）').fill('英伟达');
  await page.getByRole('button',{name:'保存',exact:true}).click();
  await page.evaluate(()=>{const h=(window as any).__newsFloatTest,id=h.state().preferences.customSources[0].id;h.state().items=[];h.ingest([{source:id,text:JSON.stringify({version:1,items:[{id:'one',body:'英伟达发布新的芯片供货计划。',publishedAt:Date.now(),tags:['半导体','公司公告'],important:true}]}),error:null,fetchedAt:Date.now()/1000}]);});
  await expect(page.locator('article')).toHaveCount(1);await expect(page.locator('.row-source')).toHaveText('个人聚合');
  await expect(page.locator('.row-meta .badge')).toHaveText('英伟达');await expect(page.getByLabel('新闻标签')).toContainText('半导体');await expect(page.locator('.source-tag')).toHaveCount(2);
  const tag=page.locator('.source-tag').first();await expect(tag).not.toHaveCSS('background-color','rgb(243, 151, 109)');await expect(tag).toHaveCSS('border-top-style','solid');
  await expect(page.getByText('原站重点',{exact:true})).toHaveCount(0);
  await page.locator('.reading-tools-summary').click();await page.locator('.source-chips').getByRole('button',{name:'个人聚合',exact:true}).click();await expect(page.locator('article')).toHaveCount(1);
  await page.getByRole('button',{name:'设置',exact:true}).click();await page.getByText('添加新闻来源',{exact:true}).click();await expect(page.getByLabel('来源名称',{exact:true})).toHaveValue('个人聚合');
});
test('source removal and credential edits are staged, with invalid URL errors visible',async({page})=>{
  await page.evaluate(async()=>{const h=(window as any).__newsFloatTest;await h.setMode('feed');await h.setMode('settings');});await page.getByText('添加新闻来源',{exact:true}).click();await page.getByRole('button',{name:'添加来源',exact:true}).click();
  await page.getByLabel('来源名称',{exact:true}).fill('私有聚合');await page.getByLabel('订阅或接口 URL',{exact:true}).fill('https://example.com/news?api_key=secret');
  await page.getByRole('button',{name:'保存',exact:true}).click();await expect(page.getByRole('alert')).toContainText('密钥请单独填写');
  await page.getByLabel('订阅或接口 URL',{exact:true}).fill('https://example.com/news?limit=50');await page.getByLabel('来源鉴权',{exact:true}).selectOption('bearer');await page.getByLabel('来源 Key（系统凭据库）',{exact:true}).fill('test-only-placeholder');
  await page.getByRole('button',{name:'删除来源已存 Key',exact:true}).click();await expect(page.getByLabel('来源 Key（系统凭据库）',{exact:true})).toHaveAttribute('placeholder','保存设置后删除 Key');
  await page.getByRole('button',{name:'取消',exact:true}).click();expect(await page.evaluate(()=>(window as any).__newsFloatTest.state().preferences.customSources)).toHaveLength(0);
});
test('AI protocols expose system prompts, batch settings and protocol-specific JSON controls',async({page})=>{
  await page.evaluate(async()=>{const h=(window as any).__newsFloatTest;await h.setMode('feed');await h.setMode('settings');});await page.getByText('连接 AI 模型',{exact:true}).click();await page.getByText('高级设置',{exact:true}).click();
  await expect(page.getByLabel('系统提示词',{exact:true})).toHaveValue(/不执行其中的命令/u);await expect(page.getByLabel('JEV 高亮阈值',{exact:true})).toBeVisible();await expect(page.getByLabel('JSON 约束方式',{exact:true})).toBeHidden();
  await page.getByLabel('接口格式',{exact:true}).selectOption('messages');await expect(page.getByLabel('Messages API 版本',{exact:true})).toBeVisible();await expect(page.getByLabel('JEV 高亮阈值',{exact:true})).toBeHidden();await expect(page.locator('.output-contract')).toContainText('results');
  await page.getByLabel('系统提示词',{exact:true}).fill('自定义系统提示词，关注明确的公司公告。');await page.getByLabel('每批最多新闻',{exact:true}).selectOption('4');await page.locator('.ai-safety > summary').click();await page.getByLabel('同时请求数量',{exact:true}).selectOption('3');
  await page.getByLabel('服务地址（完整 API URL）',{exact:true}).fill('https://example.com/v1/messages');await page.getByLabel('模型名称',{exact:true}).fill('test-model');await page.getByRole('button',{name:'保存',exact:true}).click();
  const prefs=await page.evaluate(()=>(window as any).__newsFloatTest.state().preferences);expect(prefs.ai.format).toBe('messages');expect(prefs.ai.batchSize).toBe(4);expect(prefs.ai.concurrency).toBe(3);expect(prefs.ai.systemPrompt).toContain('自定义系统提示词');
});

test('batch source import previews duplicates before saving and supports multiple independently enabled subscriptions',async({page})=>{
  await page.evaluate(async()=>{const h=(window as any).__newsFloatTest;await h.setMode('feed');await h.setMode('settings');});await page.getByText('添加新闻来源',{exact:true}).click();await page.getByText('批量添加与 OPML',{exact:true}).click();
  await page.getByLabel('订阅地址或订阅目录',{exact:true}).fill('A Feed | https://a.example/rss\nB Feed | https://b.example/atom\nhttps://a.example/rss');
  await page.getByRole('button',{name:'预览导入',exact:true}).click();await expect(page.locator('.subscription-import [role=status]')).toContainText('可安装2个，重复1个');
  expect(await page.evaluate(()=>(window as any).__newsFloatTest.state().preferences.customSources.length)).toBe(0);
  await page.getByRole('button',{name:'安装这些来源',exact:true}).click();await expect(page.locator('.custom-source')).toHaveCount(2);
  await page.locator('.custom-source').filter({hasText:'A Feed'}).getByLabel('A Feed',{exact:true}).uncheck();await page.getByRole('button',{name:'保存',exact:true}).click();
  const prefs=await page.evaluate(()=>(window as any).__newsFloatTest.state().preferences);expect(prefs.customSources).toHaveLength(2);expect(prefs.sources).not.toContain(prefs.customSources.find((s:any)=>s.name==='A Feed').id);expect(prefs.sources).toContain(prefs.customSources.find((s:any)=>s.name==='B Feed').id);
});
test('OPML file import retains nested folders and can export subscription XML without credentials',async({page})=>{
  await page.evaluate(async()=>{const h=(window as any).__newsFloatTest;await h.setMode('feed');await h.setMode('settings');});await page.getByText('添加新闻来源',{exact:true}).click();await page.getByText('批量添加与 OPML',{exact:true}).click();
  const xml='<?xml version="1.0"?><opml version="2.0"><body><outline text="科技"><outline text="AI"><outline text="A &amp; B" type="rss" xmlUrl="https://example.com/rss?q=1&amp;limit=20"/><outline text="Atom" type="rss" xmlUrl="https://example.com/atom"/></outline></outline></body></opml>';
  await page.locator('input[type=file]').setInputFiles({name:'sources.opml',mimeType:'text/xml',buffer:Buffer.from(xml)});await expect(page.locator('.subscription-import [role=status]')).toContainText('可安装2个');
  await page.getByRole('button',{name:'安装这些来源',exact:true}).click();await page.getByRole('button',{name:'导出 OPML',exact:true}).click();await expect(page.getByLabel('导出的订阅文本',{exact:true})).toHaveValue(/A &amp; B/u);
  const exported=await page.getByLabel('导出的订阅文本',{exact:true}).inputValue();expect(exported).toContain('科技 / AI');expect(exported).toContain('q=1&amp;limit=20');expect(exported).not.toContain('apiKey');
  await page.getByRole('button',{name:'保存',exact:true}).click();const prefs=await page.evaluate(()=>(window as any).__newsFloatTest.state().preferences);expect(prefs.customSources[0].folder).toBe('科技 / AI');
});
test('local adapter directory imports its rules and every source still enters through standard JSON',async({page})=>{
  await page.evaluate(async()=>{const h=(window as any).__newsFloatTest;await h.setMode('feed');await h.setMode('settings');});await page.getByText('添加新闻来源',{exact:true}).click();await page.getByText('批量添加与 OPML',{exact:true}).click();
  const adapter={itemsPath:'data.rows',idPath:'uid',bodyPaths:['content'],datePath:'time',dateUnit:'seconds'};
  await page.getByLabel('订阅地址或订阅目录',{exact:true}).fill(JSON.stringify({version:1,sources:[{name:'本地适配器',url:'https://example.com/raw',format:'adapter',adapter}]}));await page.getByRole('button',{name:'预览导入',exact:true}).click();await page.getByRole('button',{name:'安装这些来源',exact:true}).click();await expect(page.getByLabel('本地适配器规则',{exact:true})).toHaveValue(/data.rows/u);
  await page.getByRole('button',{name:'保存',exact:true}).click();const prefs=await page.evaluate(()=>(window as any).__newsFloatTest.state().preferences);expect(prefs.customSources[0].adapter).toEqual(adapter);
  await page.evaluate(()=>{const h=(window as any).__newsFloatTest,id=h.state().preferences.customSources[0].id;h.state().items=[];h.ingest([{source:id,text:JSON.stringify({version:1,items:[{id:'normalized',body:'适配器已经输出标准 JSON，消费层无需识别原站协议。',publishedAt:Date.now(),tags:['标准协议']}]}),error:null,fetchedAt:Date.now()/1000}]);});
  await expect(page.locator('article')).toHaveCount(1);await expect(page.locator('.news-body')).toContainText('消费层无需识别原站协议');
});
test('one failed source does not discard successful normalized feeds from other sources',async({page})=>{
  await page.evaluate(()=>{const h=(window as any).__newsFloatTest,s=h.state();s.items=[];s.preferences.customSources=['rss','atom','broken'].map(id=>({id:`custom:${id}`,name:id,url:`https://example.com/${id}`,format:'feed',auth:'none'}));s.preferences.sources=s.preferences.customSources.map((x:any)=>x.id);h.ingest([{source:'custom:rss',text:JSON.stringify({version:1,items:[{id:'one',body:'RSS 转换后的第一条新闻。',publishedAt:Date.now()}]}),error:null,fetchedAt:Date.now()/1000},{source:'custom:atom',text:JSON.stringify({version:1,items:[{id:'two',body:'Atom 转换后的第二条不同新闻。',publishedAt:Date.now()-1000}]}),error:null,fetchedAt:Date.now()/1000},{source:'custom:broken',text:null,error:'测试超时',fetchedAt:Date.now()/1000}]);return h.setMode('feed');});
  await expect(page.locator('article')).toHaveCount(2);await page.locator('.status-button').click();await expect(page.locator('.diagnostics')).toContainText('broken：测试超时');await expect(page.locator('.diagnostics')).toContainText('rss：1 条');await expect(page.locator('.diagnostics')).toContainText('atom：1 条');
});

test('long news starts folded, opens without losing text, survives annotation refresh and can fold from its start',async({page})=>{
  await page.clock.install();
  const full=await page.evaluate(()=>{
    const h=(window as any).__newsFloatTest;h.state().items=[];h.state().unread=[];
    const body='【来源原始标题】\n'+('原始正文保留数字 123.45%，以及限定条件和完整上下文。\n'.repeat(16))+'<script>不得执行</script>';
    h.add([{id:'cls:long-read',source:'cls',title:'来源原始标题',body,publishedAt:Date.now(),url:'',tags:[]},{id:'jin10:short-read',source:'jin10',title:'',body:'短快讯直接完整显示。',publishedAt:Date.now()-60000,url:'',tags:[]}]);
    h.setMode('feed');return body;
  });
  const long=page.locator('article').first(),body=long.locator('.news-body');
  await expect(long.getByRole('button',{name:'展开全文',exact:true})).toBeVisible();
  await expect(body).toHaveText(full);await expect(body.locator('script')).toHaveCount(0);
  const previewHeight=await body.evaluate(e=>e.clientHeight);
  expect(await body.evaluate(e=>e.scrollHeight)).toBeGreaterThan(previewHeight*3);
  await expect(page.locator('article').nth(1).locator('.story-toggle')).toBeHidden();
  await long.getByRole('button',{name:'展开全文',exact:true}).click();
  await expect(long.getByRole('button',{name:'收起全文',exact:true})).toHaveAttribute('aria-expanded','true');
  expect(await body.evaluate(e=>e.clientHeight)).toBeGreaterThan(previewHeight*3);
  await page.evaluate(()=>{const h=(window as any).__newsFloatTest;h.state().preferences.keywordEnabled=true;h.state().preferences.keywords='123.45';h.add(h.state().items);});
  await expect(long).toHaveClass(/matched/);await expect(long.getByRole('button',{name:'收起全文',exact:true})).toBeVisible();
  await expect(long.locator('.news-body')).toHaveText(full);
  const collapse=long.getByRole('button',{name:'收起全文',exact:true});
  expect((await collapse.boundingBox())!.y).toBeLessThan((await long.locator('.news-body').boundingBox())!.y);
  await collapse.focus();await page.keyboard.press('Enter');
  await expect(long.getByRole('button',{name:'展开全文',exact:true})).toHaveAttribute('aria-expanded','false');
  expect(await long.locator('.news-body').evaluate(e=>e.clientHeight)).toBe(previewHeight);
  await expect(long.getByRole('button',{name:'展开全文',exact:true})).toBeFocused();
});

test('preview disclosure follows real wrapping at different widths and preserves explicit opening across modes',async({page})=>{
  await page.clock.install();await page.setViewportSize({width:320,height:400});
  await page.evaluate(()=>{const h=(window as any).__newsFloatTest;h.state().items=[];h.add([{id:'cls:wrap',source:'cls',title:'',body:'这是一段用于宽度变化验证的原始快讯，文本在窄窗口中需要展开，在足够宽的窗口中可以完整展示。'.repeat(2),publishedAt:Date.now(),url:'',tags:[]}]);return h.setMode('feed');});
  await expect(page.getByRole('button',{name:'展开全文',exact:true})).toBeVisible();
  await page.setViewportSize({width:1000,height:400});await page.clock.runFor(100);await expect(page.locator('.story-toggle')).toBeHidden();
  await page.setViewportSize({width:320,height:400});await page.clock.runFor(100);await expect(page.getByRole('button',{name:'展开全文',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'展开全文',exact:true}).click();
  await page.getByRole('button',{name:'收起',exact:true}).click();await page.locator('.ticker').click();
  await expect(page.getByRole('button',{name:'收起全文',exact:true})).toBeVisible();
});

test('reader chrome discloses low-frequency actions, supports keyboard menu dismissal and keeps search filters explicit',async({page})=>{
  await page.evaluate(()=>(window as any).__newsFloatTest.setMode('feed'));
  await expect(page.getByRole('searchbox',{name:'搜索快讯'})).toBeHidden();
  await expect(page.getByRole('button',{name:'立即刷新',exact:true})).toBeHidden();
  await page.locator('.reader-menu > summary').click();
  await expect(page.getByRole('button',{name:'立即刷新',exact:true})).toBeVisible();
  await page.keyboard.press('Escape');await expect(page.locator('.feed')).toBeVisible();
  await expect(page.locator('.reader-menu > summary')).toBeFocused();
  await page.locator('.reader-menu > summary').click();await page.getByRole('button',{name:'暂停更新',exact:true}).click();
  await expect(page.locator('.follow-button')).toHaveText('已暂停更新');
  await page.locator('.reader-menu > summary').click();await page.getByRole('button',{name:'继续更新',exact:true}).click();
  await page.keyboard.press('Control+f');await expect(page.getByRole('searchbox',{name:'搜索快讯'})).toBeFocused();
  await page.getByRole('searchbox',{name:'搜索快讯'}).fill('验证搜索');
  await page.locator('.reading-tools-summary').click();await expect(page.locator('.reading-tools-label')).toHaveText('搜索：验证搜索');
});

test('source time is distinguished from first retrieval and AI explanations share one disclosure with original sources',async({page})=>{
  await page.clock.install();
  await page.evaluate(()=>{const h=(window as any).__newsFloatTest,s=h.state();s.items=[];s.unread=[];Object.assign(s.preferences,{aiEnabled:true,interests:'政策',keywordEnabled:false});
    const body='政策部门宣布新一轮基础设施支持计划，相关项目按季度逐步落地。';
    const a={id:'cls:origin-a',source:'cls',title:'',body,publishedAt:Date.now(),dateEstimated:true,url:'https://example.com/a',tags:['宏观']};
    Object.assign(a,{judgement:{kind:'json',relevant:true,probability:1,model:'test',fingerprint:h.fingerprint(a),reason:'命中用户关注的政策信息。',tags:['政策']}});
    h.add([a,{...a,id:'jin10:origin-b',source:'jin10',publishedAt:Date.now()-1000,dateEstimated:false,url:'https://example.com/b',judgement:undefined}]);h.setAIStatus(true);return h.setMode('feed');});
  const row=page.locator('article');await expect(row).toHaveCount(1);
  await expect(row.locator('.estimated-time')).toHaveText('首次获取');await expect(row.locator('time')).toHaveAttribute('title',/首次获取时间/);
  await expect(row.locator('.story-details')).not.toHaveAttribute('open');await expect(row.locator('.ai-reason')).toBeHidden();
  await row.locator('.story-details > summary').click();
  await expect(row.locator('.ai-reason')).toHaveText('命中用户关注的政策信息。');
  await expect(row.getByLabel('AI 标签',{exact:true})).toContainText('AI · 政策');
  await expect(row.getByLabel('新闻标签',{exact:true})).toContainText('宏观');
  await expect(row.locator('.related p')).toHaveCount(2);await expect(row.locator('.related p').first()).toHaveText('政策部门宣布新一轮基础设施支持计划，相关项目按季度逐步落地。');
  await expect(row.locator('.badge.ai-match')).toHaveText('AI 关注');
});

test('preinstalled channels distinguish disabling from uninstalling, and cancel rolls back the installation draft',async({page})=>{
  await page.evaluate(async()=>{const h=(window as any).__newsFloatTest;await h.setMode('feed');await h.setMode('settings');});
  const installed=page.getByLabel('已安装来源',{exact:true});await expect(installed.locator('.source-entry')).toHaveCount(3);
  await installed.getByLabel('财联社',{exact:true}).uncheck();
  await expect(installed.getByRole('button',{name:'卸载财联社',exact:true})).toBeVisible();
  await installed.getByRole('button',{name:'卸载财联社',exact:true}).click();
  await expect(installed.getByLabel('财联社',{exact:true})).toHaveCount(0);
  await expect(page.getByLabel('可安装来源',{exact:true}).getByRole('button',{name:'安装财联社',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'取消',exact:true}).click();
  const prefs=await page.evaluate(()=>(window as any).__newsFloatTest.state().preferences);expect(prefs.uninstalledSources).toEqual([]);expect(prefs.sources).toContain('cls');
});

test('saved builtin uninstall survives mode changes, leaves cached news intact, and can reinstall through the same catalog',async({page})=>{
  const ids=await page.evaluate(()=>(window as any).__newsFloatTest.state().items.map((item:any)=>item.id));
  await page.evaluate(async()=>{const h=(window as any).__newsFloatTest;await h.setMode('feed');await h.setMode('settings');});
  await page.getByRole('button',{name:'卸载财联社',exact:true}).click();await page.getByRole('button',{name:'保存',exact:true}).click();
  await expect(page.locator('article')).toHaveCount(0);
  expect(await page.evaluate(()=>(window as any).__newsFloatTest.state().items.map((item:any)=>item.id))).toEqual(ids);
  await page.getByRole('button',{name:'设置',exact:true}).click();
  await expect(page.getByLabel('已安装来源',{exact:true}).locator('.source-entry')).toHaveCount(2);
  await page.getByText('添加新闻来源',{exact:true}).click();await page.getByRole('button',{name:'安装财联社',exact:true}).click();
  await expect(page.getByLabel('已安装来源',{exact:true}).getByLabel('财联社',{exact:true})).toBeChecked();
  await page.getByRole('button',{name:'保存',exact:true}).click();await expect(page.locator('article').first()).toBeVisible();
  const prefs=await page.evaluate(()=>(window as any).__newsFloatTest.state().preferences);expect(prefs.uninstalledSources).toEqual([]);expect(prefs.sources.filter((id:string)=>id==='cls')).toHaveLength(1);
});

test('all channels can be uninstalled and the compact empty state leads back to installation',async({page})=>{
  await page.evaluate(async()=>{const h=(window as any).__newsFloatTest;await h.setMode('feed');await h.setMode('settings');});
  for(const name of ['财联社','华尔街见闻','金十'])await page.getByRole('button',{name:`卸载${name}`,exact:true}).click();
  await page.getByRole('button',{name:'保存',exact:true}).click();await expect(page.locator('.empty')).toContainText('还没有启用新闻来源');
  await page.getByRole('button',{name:'收起',exact:true}).click();await expect(page.locator('.ticker-copy')).toContainText('点击添加新闻来源');
  await page.locator('.ticker').focus();await page.keyboard.press('Enter');
  await expect(page.locator('.settings')).toBeVisible();await page.getByText('添加新闻来源',{exact:true}).click();
  await expect(page.getByLabel('可安装来源',{exact:true}).getByRole('button')).toHaveCount(3);
});

test('third-party adapter packages install into the same list and reinstall without creating a second channel or changing IDs',async({page})=>{
  await page.evaluate(async()=>{const h=(window as any).__newsFloatTest;await h.setMode('feed');await h.setMode('settings');});await page.getByText('添加新闻来源',{exact:true}).click();
  const source={id:'custom:publisher-finance',name:'我的逻辑来源',url:'https://example.com/raw',format:'adapter',adapter:{itemsPath:'data.rows',idPath:'uid',bodyPaths:['text'],datePath:'time',dateUnit:'seconds'}};
  const file={name:'finance.news-source.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify({version:1,sources:[source]}))};
  await page.locator('input[type=file]').setInputFiles(file);await expect(page.locator('.subscription-import [role=status]')).toContainText('可安装1个');
  await page.getByRole('button',{name:'安装这些来源',exact:true}).click();
  await expect(page.getByLabel('已安装来源',{exact:true}).getByLabel('我的逻辑来源',{exact:true})).toBeChecked();
  await expect(page.getByLabel('本地适配器规则',{exact:true})).toHaveValue(/data.rows/);
  await page.getByRole('button',{name:'保存',exact:true}).click();
  await page.getByRole('button',{name:'设置',exact:true}).click();await page.getByRole('button',{name:'卸载我的逻辑来源',exact:true}).click();await page.getByRole('button',{name:'保存',exact:true}).click();
  let prefs=await page.evaluate(()=>(window as any).__newsFloatTest.state().preferences);expect(prefs.customSources).toHaveLength(1);expect(prefs.uninstalledSources).toContain(source.id);
  await page.getByRole('button',{name:'设置',exact:true}).click();await page.getByText('添加新闻来源',{exact:true}).click();
  await page.locator('input[type=file]').setInputFiles(file);await expect(page.locator('.subscription-import [role=status]')).toContainText('可安装1个');await expect(page.locator('.subscription-preview')).toContainText('重新安装');
  await page.getByRole('button',{name:'安装这些来源',exact:true}).click();await page.getByText('批量添加与 OPML',{exact:true}).click();await page.getByRole('button',{name:'导出完整来源目录',exact:true}).click();
  const exported=JSON.parse(await page.getByLabel('导出的订阅文本',{exact:true}).inputValue());expect(exported.version).toBe(2);expect(exported.sources.some((item:any)=>item.manifest?.id==='cls')).toBe(true);expect(exported.sources.find((item:any)=>item.id===source.id).adapter).toEqual(source.adapter);
  await page.getByRole('button',{name:'保存',exact:true}).click();prefs=await page.evaluate(()=>(window as any).__newsFloatTest.state().preferences);expect(prefs.customSources).toHaveLength(1);expect(prefs.customSources[0].id).toBe(source.id);expect(prefs.sources).toContain(source.id);
});


test('preinstalled sources and a user copy of CLS use the same executable package shape and installation controls',async({page})=>{
  const bundled=JSON.parse(readFileSync(new URL('../../source-adapters/packages/preinstalled.json',import.meta.url),'utf8'));
  const plugin=structuredClone(bundled.sources[0]);plugin.manifest.id='custom:my-cls';plugin.manifest.name='我的财联社示例';
  await page.evaluate(async()=>{const h=(window as any).__newsFloatTest;await h.setMode('feed');await h.setMode('settings');});
  await expect(page.getByLabel('已安装来源',{exact:true}).locator('.plugin-source')).toHaveCount(3);
  const built=page.getByRole('region',{name:'财联社来源',exact:true});await built.locator('.source-editor > summary').click();await expect(built).toContainText('https://www.cls.cn');await expect(built.getByRole('button',{name:'测试来源',exact:true})).toBeVisible();
  await page.getByText('添加新闻来源',{exact:true}).click();
  await page.locator('input[type=file]').setInputFiles({name:'my-cls.news-source.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify({version:2,sources:[plugin]}))});
  await expect(page.locator('.subscription-preview')).toContainText('v1.0.0');await expect(page.locator('.subscription-preview')).toContainText('网络：https://www.cls.cn');
  await page.getByRole('button',{name:'安装这些来源',exact:true}).click();await page.getByRole('button',{name:'保存',exact:true}).click();
  let source=await page.evaluate(()=>(window as any).__newsFloatTest.state().preferences.customSources.find((s:any)=>s.id==='custom:my-cls'));expect(source.format).toBe('plugin');expect(source.plugin.script).toBe(bundled.sources[0].script);
  await page.getByRole('button',{name:'设置',exact:true}).click();await page.getByRole('button',{name:'卸载我的财联社示例',exact:true}).click();await page.getByRole('button',{name:'安装我的财联社示例',exact:true}).click();
  await page.getByRole('button',{name:'保存',exact:true}).click();source=await page.evaluate(()=>(window as any).__newsFloatTest.state().preferences.customSources.find((s:any)=>s.id==='custom:my-cls'));expect(source.plugin.script).toBe(bundled.sources[0].script);
});

test('executable package updates require an explicit install, retain configuration and refuse older versions',async({page})=>{
  const p={manifest:{id:'custom:configured-js',name:'可配置逻辑来源',version:'1.0.0',apiVersion:1,entry:'adapter.js',network:['https://example.com'],config:[{key:'topic',label:'资讯频道',kind:'string',default:'market',required:true}]},script:'function fetch(ctx){return {version:1,items:[]};}'};
  const upload=async()=>{await page.locator('input[type=file]').setInputFiles({name:'logic.news-source.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify({version:2,sources:[p]}))});};
  await page.evaluate(async()=>{const h=(window as any).__newsFloatTest;await h.setMode('feed');await h.setMode('settings');});await page.getByText('添加新闻来源',{exact:true}).click();await upload();await page.getByRole('button',{name:'安装这些来源',exact:true}).click();
  const region=page.getByRole('region',{name:'可配置逻辑来源来源',exact:true});await region.locator('.source-editor > summary').click();await page.getByLabel('资讯频道',{exact:true}).fill('chips');await page.getByRole('button',{name:'保存',exact:true}).click();
  await page.getByRole('button',{name:'设置',exact:true}).click();await page.getByText('添加新闻来源',{exact:true}).click();p.manifest.version='1.1.0';await upload();await expect(page.locator('.subscription-preview')).toContainText('更新／替换');
  expect(await page.evaluate(()=>(window as any).__newsFloatTest.state().preferences.customSources[0].plugin.manifest.version)).toBe('1.0.0');
  await page.getByRole('button',{name:'安装这些来源',exact:true}).click();await page.getByRole('button',{name:'保存',exact:true}).click();
  const source=await page.evaluate(()=>(window as any).__newsFloatTest.state().preferences.customSources[0]);expect(source.plugin.manifest.version).toBe('1.1.0');expect(source.parameters.topic).toBe('chips');
  await page.getByRole('button',{name:'设置',exact:true}).click();await page.getByText('添加新闻来源',{exact:true}).click();p.manifest.version='0.9.0';await upload();await expect(page.locator('.subscription-import [role=status]')).toContainText('低版本');await expect(page.getByRole('button',{name:'安装这些来源',exact:true})).toBeDisabled();
});

test('the full preinstalled file restores all uninstalled sources using package contents and preserves their original IDs',async({page})=>{
  const file=readFileSync(new URL('../../source-adapters/packages/preinstalled.json',import.meta.url));
  await page.evaluate(async()=>{const h=(window as any).__newsFloatTest;await h.setMode('feed');await h.setMode('settings');});for(const name of ['财联社','华尔街见闻','金十'])await page.getByRole('button',{name:`卸载${name}`,exact:true}).click();
  await page.locator('input[type=file]').setInputFiles({name:'preinstalled.news-source.json',mimeType:'application/json',buffer:file});await expect(page.locator('.subscription-import [role=status]')).toContainText('可安装3个');
  await page.getByRole('button',{name:'安装这些来源',exact:true}).click();await page.getByRole('button',{name:'保存',exact:true}).click();const prefs=await page.evaluate(()=>(window as any).__newsFloatTest.state().preferences);expect([...prefs.sources].sort()).toEqual(['cls','jin10','wallstreet']);expect(prefs.uninstalledSources).toEqual([]);
});

test('editing import text invalidates an in-flight package inspection and cannot enable a stale installation',async({page})=>{
  const p=JSON.parse(readFileSync(new URL('../../source-adapters/packages/preinstalled.json',import.meta.url),'utf8')).sources[0];p.manifest.id='custom:slow-inspect';
  await page.evaluate(async()=>{const bridge=(window as any).__newsFloatTest.bridge;bridge.inspectPackages=()=>new Promise<void>(resolve=>{(window as any).finishInspection=resolve;});});
  await page.evaluate(async()=>{const h=(window as any).__newsFloatTest;await h.setMode('feed');await h.setMode('settings');});await page.getByText('添加新闻来源',{exact:true}).click();await page.getByText('批量添加与 OPML',{exact:true}).click();
  await page.getByLabel('订阅地址或订阅目录',{exact:true}).fill(JSON.stringify({version:2,sources:[p]}));await page.getByRole('button',{name:'预览导入',exact:true}).click();await expect(page.locator('.subscription-import [role=status]')).toContainText('检查脚本中');
  await page.getByLabel('订阅地址或订阅目录',{exact:true}).fill('输入已经改变');await page.evaluate(()=>(window as any).finishInspection());await expect(page.getByRole('button',{name:'安装这些来源',exact:true})).toBeDisabled();
});
