import {test,expect,type Page} from '@playwright/test';
test.beforeEach(async({page})=>{await page.goto('/');await page.waitForFunction(()=>!!(window as any).__newsFloatTest);});
async function seed(page:Page,count=3){await page.setViewportSize({width:300,height:34});await page.clock.install();await page.mouse.move(0,100);await page.evaluate(n=>{const h=(window as any).__newsFloatTest,s=h.state();s.items=[];s.playbackHistory=[];s.preferences.scrollSpeed=100;h.add(Array.from({length:n},(_,i)=>({id:`cls:played-${i}`,source:'cls',title:`新闻 ${i}`,body:`新闻 ${i} 的具体事实和数据，需要完整播放后才能记为播完。`.repeat(8),publishedAt:Date.now()-i*60000,url:'',tags:[]})));},count);}
async function finish(page:Page,initial=false){const remaining=await page.evaluate(()=>(window as any).__newsFloatTest.tickerCompletionDistance()-(window as any).__newsFloatTest.tickerPosition());await page.clock.runFor((initial?2200:0)+Math.ceil(remaining*10)+48);}
test('new arrivals wait for complete current text, then lead the queue without replaying completed stories',async({page})=>{
  await seed(page);await finish(page,true);await expect(page.locator('.ticker-copy')).toContainText('新闻 1');
  await page.evaluate(()=>{const h=(window as any).__newsFloatTest;h.add([{id:'jin10:new',source:'jin10',title:'刚到的新消息',body:'刚到的新消息，新增一项重要的公开市场信息。'.repeat(10),publishedAt:Date.now(),url:'',tags:[]}]);});
  await expect(page.locator('.ticker-copy')).toContainText('新闻 1');await expect(page.locator('.ticker-upcoming')).toContainText('刚到的新消息');
  await finish(page);await expect(page.locator('.ticker-copy')).toContainText('刚到的新消息');
  await finish(page);await expect(page.locator('.ticker-copy')).toContainText('新闻 2');await finish(page);
  const stopped=await page.evaluate(()=>(window as any).__newsFloatTest.tickerPosition());expect(await page.evaluate(()=>(window as any).__newsFloatTest.state().playbackHistory.length)).toBe(4);
  await page.clock.runFor(30000);await expect(page.locator('.ticker-copy')).toContainText('新闻 2');expect(await page.evaluate(()=>(window as any).__newsFloatTest.tickerPosition())).toBe(stopped);
});
test('repeats can be enabled while expanded lists always include played news',async({page})=>{await seed(page,2);await finish(page,true);await finish(page);await page.setViewportSize({width:480,height:700});await page.evaluate(()=>(window as any).__newsFloatTest.setMode('feed'));await expect(page.locator('article')).toHaveCount(2);await page.evaluate(()=>(window as any).__newsFloatTest.setMode('settings'));await expect(page.getByLabel('跳过已播放新闻（收起时）')).toBeChecked();await page.getByLabel('跳过已播放新闻（收起时）').uncheck();await page.getByRole('button',{name:'保存',exact:true}).click();await page.getByRole('button',{name:'收起',exact:true}).click();await page.setViewportSize({width:300,height:34});await finish(page,true);await expect(page.locator('.ticker-copy')).toContainText('新闻 1');await finish(page);await expect(page.locator('.ticker-copy')).toContainText('新闻 0');});
test('clicking an older ticker story locates its full text without rendering every preceding story',async({page})=>{await page.evaluate(()=>{const h=(window as any).__newsFloatTest,s=h.state();s.items=[];s.preferences.autoScroll=false;h.add(Array.from({length:200},(_,i)=>({id:`cls:anchor-${i}`,source:'cls',title:`第 ${i} 条原始标题`,body:`第 ${i} 条原始标题的完整正文，保留所有背景与事实。`.repeat(25),publishedAt:Date.now()-i*60000,url:'',tags:[]})));});await page.setViewportSize({width:380,height:420});await page.locator('.ticker').focus();for(let i=0;i<70;i++)await page.keyboard.press('ArrowRight');await expect(page.locator('.ticker-copy')).toContainText('第 70 条');await page.locator('.ticker').click({position:{x:70,y:15}});const article=page.locator('article[data-id="cls:anchor-70"]');await expect(article).toHaveClass(/story-expanded/);await expect(article).toBeInViewport();expect(await page.locator('article').count()).toBeLessThanOrEqual(40);expect(await article.evaluate(e=>Math.abs(e.getBoundingClientRect().top-e.closest('.news-scroll')!.getBoundingClientRect().top))).toBeLessThan(2);await page.getByRole('button',{name:'回到最新',exact:true}).click();await expect(page.locator('article').first()).toHaveAttribute('data-id','cls:anchor-0');});
test('compact context menu offers latest and explicit AI state without adding hover controls',async({page})=>{await page.setViewportSize({width:480,height:400});await page.locator('.ticker').click({button:'right',position:{x:40,y:15}});await expect(page.getByRole('button',{name:'查看最新快讯',exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'开启 AI',exact:true})).toBeVisible();await page.getByRole('button',{name:'开启 AI',exact:true}).click();await expect(page.locator('.settings')).toBeVisible();await page.evaluate(()=>{const h=(window as any).__newsFloatTest;h.state().preferences.aiEnabled=true;h.state().preferences.aiPaused=false;return h.setMode('compact');});await page.locator('.ticker').click({button:'right',position:{x:40,y:15}});await page.getByRole('button',{name:'关闭 AI',exact:true}).click();expect(await page.evaluate(()=>(window as any).__newsFloatTest.state().preferences.aiPaused)).toBe(true);await expect(page.locator('.ticker-previous,.ticker-next')).toHaveCount(2);});

test('automatic playback promotes the already visible next story without a visual reset',async({page})=>{
  await seed(page);
  const distance=await page.evaluate(()=>(window as any).__newsFloatTest.tickerDistance());
  await page.clock.runFor(2200+Math.ceil((distance-10)*10));
  const sample=()=>page.evaluate(()=>{
    const h=(window as any).__newsFloatTest,track=document.querySelector('.ticker-track')!;
    // Synchronize the compositor to the controlled logical clock before measuring pixels.
    const animation=track.getAnimations()[0];if(animation)animation.currentTime=h.tickerPosition()*10;
    const current=document.querySelector('.ticker-copy')!,next=document.querySelector('.ticker-upcoming')!;
    return {current:current.textContent,next:next.textContent,currentX:current.getBoundingClientRect().left,nextX:next.getBoundingClientRect().left,viewportX:document.querySelector('.ticker')!.getBoundingClientRect().left};
  });
  const before=await sample();expect(before.current).toContain('新闻 0');expect(before.next).toContain('新闻 1');expect(before.nextX-before.viewportX).toBeGreaterThan(4);expect(before.nextX-before.viewportX).toBeLessThan(18);
  await page.clock.runFor(120);
  const after=await sample();expect(after.current).toBe(before.next);expect(after.next).toContain('新闻 2');expect(before.nextX-after.currentX).toBeGreaterThanOrEqual(0);expect(before.nextX-after.currentX).toBeLessThan(18);
  await expect(page.locator('.ticker-track > span')).toHaveCount(2);
});
test('clicking the incoming highlighted text opens that story rather than the outgoing one',async({page})=>{
  await seed(page);
  await page.evaluate(()=>{const h=(window as any).__newsFloatTest,s=h.state();s.preferences.keywordEnabled=true;s.preferences.keywords='新闻 1';h.add([]);});
  const distance=await page.evaluate(()=>(window as any).__newsFloatTest.tickerDistance());
  await page.clock.runFor(2200+Math.ceil((distance-100)*10));
  await page.evaluate(()=>{const h=(window as any).__newsFloatTest,a=document.querySelector('.ticker-track')!.getAnimations()[0];if(a)a.currentTime=h.tickerPosition()*10;});
  await expect(page.locator('.ticker-upcoming')).toHaveClass(/matched/);
  const rect=await page.locator('.ticker-upcoming').boundingBox();await page.mouse.click(rect!.x+5,rect!.y+15);await page.setViewportSize({width:480,height:640});await page.clock.runFor(50);
  const story=page.locator('article[data-id="cls:played-1"]');await expect(story).toHaveClass(/story-expanded/);await expect(story).toBeInViewport();
});
test('short news keeps its reading interval and revealing arrows does not shift the upcoming story',async({page})=>{
  await page.clock.install();await page.setViewportSize({width:300,height:34});await page.mouse.move(0,100);
  await page.evaluate(()=>{const h=(window as any).__newsFloatTest,s=h.state();s.items=[];s.playbackHistory=[];s.preferences.scrollSpeed=100;h.add([{id:'cls:short',source:'cls',title:'',body:'简短消息',publishedAt:Date.now(),url:'',tags:[]},{id:'cls:after-short',source:'cls',title:'',body:'接着展示的下一条消息。'.repeat(10),publishedAt:Date.now()-60000,url:'',tags:[]}]);});
  await page.clock.runFor(6000);expect(await page.evaluate(()=>(window as any).__newsFloatTest.tickerPosition())).toBe(0);
  const distance=await page.evaluate(()=>(window as any).__newsFloatTest.tickerDistance());await page.locator('.pill').hover({position:{x:20,y:17}});expect(await page.evaluate(()=>(window as any).__newsFloatTest.tickerDistance())).toBe(distance);
  await page.mouse.move(0,100);await page.clock.runFor(1100);expect(await page.evaluate(()=>(window as any).__newsFloatTest.tickerPosition())).toBeGreaterThan(30);
});

test('rapid refreshes keep the entire current story and coalesce only its offscreen successor',async({page})=>{
  await seed(page);await page.clock.runFor(3300);
  const body=await page.locator('.ticker-copy').textContent();
  for(let i=0;i<10;i++){
    const delta=await page.evaluate(i=>{
      const h=(window as any).__newsFloatTest;h.tickerSync();const node=document.querySelector('.ticker-copy')!;const before=node.getBoundingClientRect().left;
      h.add([{id:`jin10:live-${i}`,source:'jin10',title:`实时消息 ${i}`,body:`实时消息 ${i} 的完整正文。`.repeat(10),publishedAt:Date.now()+i*1000,url:'',tags:[]}]);
      return node.getBoundingClientRect().left-before;
    },i);
    expect(Math.abs(delta)).toBeLessThan(1);await expect(page.locator('.ticker-copy')).toHaveText(body!);await expect(page.locator('.ticker-outgoing')).toHaveCount(0);await page.clock.runFor(100);
  }
  await expect(page.locator('.ticker-upcoming')).toContainText('实时消息 9');
  const remaining=await page.evaluate(()=>(window as any).__newsFloatTest.tickerDistance()-(window as any).__newsFloatTest.tickerPosition());await page.clock.runFor(Math.ceil(remaining*10)+50);
  await expect(page.locator('.ticker-copy')).toContainText('实时消息 9');
});
test('a fully shown story is recorded before it exits, and an exhausted queue never restarts on duplicate refresh',async({page})=>{
  await seed(page,1);
  const distance=await page.evaluate(()=>(window as any).__newsFloatTest.tickerDistance());await page.clock.runFor(2200+Math.ceil(distance*10)+100);
  expect(await page.evaluate(()=>(window as any).__newsFloatTest.state().playbackHistory.length)).toBe(1);
  expect(await page.evaluate(()=>(window as any).__newsFloatTest.tickerPhase())).toBe('idle');
  const position=await page.evaluate(()=>(window as any).__newsFloatTest.tickerPosition());
  await page.evaluate(()=>{const h=(window as any).__newsFloatTest,a=h.state().items[0];h.add([{...a,id:'jin10:reprint',source:'jin10',publishedAt:a.publishedAt+1000}]);h.add(h.state().items);});
  await page.clock.runFor(30000);expect(await page.evaluate(()=>(window as any).__newsFloatTest.tickerPosition())).toBe(position);
  await expect(page.locator('.ticker-outgoing')).toHaveCount(0);await expect(page.locator('.ticker-upcoming')).toBeHidden();
});

test('refresh after the last character is visible does not requeue the completed outgoing story',async({page})=>{
  await seed(page,2);
  const readDistance=await page.locator('.ticker-copy').evaluate(e=>{const r=document.createRange();r.selectNodeContents(e);return r.getBoundingClientRect().width-document.querySelector('.ticker')!.clientWidth;});
  await page.clock.runFor(2200+Math.ceil((readDistance+5)*10));
  expect(await page.evaluate(()=>(window as any).__newsFloatTest.state().playbackHistory.some((r:any)=>r.id==='cls:played-0'))).toBe(true);
  await page.evaluate(()=>{const h=(window as any).__newsFloatTest;h.tickerSync();h.add([{id:'jin10:after-read',source:'jin10',title:'新消息',body:'刚发布的新消息和具体信息。'.repeat(10),publishedAt:Date.now(),url:'',tags:[]}]);});
  await finish(page);await expect(page.locator('.ticker-copy')).toContainText('新消息');await finish(page);await expect(page.locator('.ticker-copy')).toContainText('新闻 1');await finish(page);
  expect(await page.evaluate(()=>(window as any).__newsFloatTest.tickerPhase())).toBe('idle');await expect(page.locator('.ticker-copy')).toContainText('新闻 1');
});
test('clicking text preserved during a refresh opens the visible outgoing story',async({page})=>{
  await seed(page);await page.clock.runFor(3300);
  await page.evaluate(()=>{const h=(window as any).__newsFloatTest;h.tickerSync();h.add([{id:'jin10:click-new',source:'jin10',title:'新消息',body:'新消息的具体内容。'.repeat(10),publishedAt:Date.now(),url:'',tags:[]}]);});
  await page.mouse.click(60,17);await page.setViewportSize({width:480,height:640});await page.clock.runFor(50);
  await expect(page.locator('article[data-id="cls:played-0"]')).toHaveClass(/story-expanded/);
});

test('the complete suffix reaches the reading viewport before a refreshed successor takes over',async({page})=>{
  await seed(page,2);await page.clock.runFor(3300);
  const original=await page.locator('.ticker-copy').textContent();
  await page.evaluate(()=>{const h=(window as any).__newsFloatTest;h.add([{id:'jin10:tail-test',source:'jin10',title:'新消息',body:'刷新后排队的完整消息。'.repeat(12),publishedAt:Date.now(),url:'',tags:[]}]);});
  await expect(page.locator('.ticker-copy')).toHaveText(original!);
  const remaining=await page.locator('.ticker-copy').evaluate(e=>{const r=document.createRange();r.selectNodeContents(e);return r.getBoundingClientRect().width-document.querySelector('.ticker')!.clientWidth-(window as any).__newsFloatTest.tickerPosition()+8;});
  await page.clock.runFor(Math.ceil(remaining*10));
  const tail=await page.evaluate(()=>{const h=(window as any).__newsFloatTest;h.tickerSync();const node=document.querySelector('.ticker-copy')!,text=node.firstChild!;const range=document.createRange();range.setStart(text,text.textContent!.length-12);range.setEnd(text,text.textContent!.length);const r=range.getBoundingClientRect(),v=document.querySelector('.ticker')!.getBoundingClientRect();return {left:r.left,right:r.right,viewportLeft:v.left,viewportRight:v.right};});
  expect(tail.left).toBeGreaterThanOrEqual(tail.viewportLeft);expect(tail.right).toBeLessThanOrEqual(tail.viewportRight+1);
  await expect(page.locator('.ticker-copy')).toHaveText(original!);await expect(page.locator('.ticker-upcoming')).toContainText('新消息');
  expect(await page.locator('.ticker-copy').evaluate(e=>parseFloat(getComputedStyle(e).paddingRight))).toBeGreaterThanOrEqual(24);
});

test('a successor already entering the window keeps its full text when a newer story arrives',async({page})=>{
  await seed(page);const distance=await page.evaluate(()=>(window as any).__newsFloatTest.tickerDistance());await page.clock.runFor(2200+Math.ceil((distance-100)*10));
  await page.evaluate(()=>{const h=(window as any).__newsFloatTest;h.tickerSync();h.add([{id:'jin10:latest-while-visible',source:'jin10',title:'最新消息',body:'最新消息的完整正文。'.repeat(10),publishedAt:Date.now(),url:'',tags:[]}]);});
  await expect(page.locator('.ticker-upcoming')).toContainText('新闻 1');await finish(page);await expect(page.locator('.ticker-copy')).toContainText('新闻 1');
  await expect(page.locator('.ticker-upcoming')).toContainText('最新消息');await finish(page);await expect(page.locator('.ticker-copy')).toContainText('最新消息');
});
test('an idle-to-new transition survives horizontal wheel input and never drops the incoming suffix',async({page})=>{
  await seed(page,1);await finish(page,true);
  await page.evaluate(()=>{const h=(window as any).__newsFloatTest;h.add([{id:'jin10:from-idle',source:'jin10',title:'完整新消息',body:'完整新消息的前后文字必须连续显示。'.repeat(10),publishedAt:Date.now()+1000,url:'',tags:[]}]);});
  expect(await page.evaluate(()=>(window as any).__newsFloatTest.tickerPhase())).toBe('incoming');
  await page.locator('.ticker').dispatchEvent('wheel',{deltaX:50,deltaY:0});expect(await page.evaluate(()=>(window as any).__newsFloatTest.tickerPhase())).toBe('incoming');
  await page.mouse.move(0,100);await page.clock.runFor(20000);expect(await page.evaluate(()=>(window as any).__newsFloatTest.tickerPhase())).toBe('moving');await expect(page.locator('.ticker-copy')).toContainText('完整新消息');expect(await page.evaluate(()=>(window as any).__newsFloatTest.state().playbackHistory.some((r:any)=>r.id==='jin10:from-idle'))).toBe(false);
});
test('pause and resume preserve the current text and position without rebuilding the reader',async({page})=>{
  await seed(page);await page.clock.runFor(3300);await page.evaluate(()=>(window as any).__newsFloatTest.tickerSync());
  const text=await page.locator('.ticker-copy').textContent();await page.locator('.ticker').dispatchEvent('contextmenu',{clientX:30,clientY:15});await page.setViewportSize({width:300,height:240});
  await page.getByRole('button',{name:'暂停更新',exact:true}).click();const position=await page.evaluate(()=>(window as any).__newsFloatTest.tickerPosition());await page.clock.runFor(10000);
  expect(await page.evaluate(()=>(window as any).__newsFloatTest.tickerPosition())).toBe(position);await expect(page.locator('.ticker-copy')).toHaveText(text!);
  await page.locator('.ticker').dispatchEvent('contextmenu',{clientX:30,clientY:15});await page.getByRole('button',{name:'继续更新',exact:true}).click();await page.mouse.move(0,300);await page.clock.runFor(1000);
  expect(await page.evaluate(()=>(window as any).__newsFloatTest.tickerPosition())).toBeGreaterThan(position);await expect(page.locator('.ticker-copy')).toHaveText(text!);
});
