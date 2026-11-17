import {test,expect} from '@playwright/test';

for(const [locale,language,name,settings] of [
  ['zh-CN','zh-CN','灵动新闻','设置'],['en-US','en','LingDongNews','Settings'],
  ['ja-JP','zh-CN','灵动新闻','设置'],['fr-FR','zh-CN','灵动新闻','设置'],
]){
 test(`system language ${locale} resolves to ${language}`,async({browser,baseURL})=>{
  const context=await browser.newContext({locale,baseURL});
  try{
   const page=await context.newPage();await page.goto('/');await page.waitForFunction(()=>!!(window as any).__newsFloatTest);
   await expect(page.locator('html')).toHaveAttribute('lang',language);await expect(page).toHaveTitle(name);
   await page.locator('.ticker').click({button:'right',position:{x:40,y:15}});
   await page.getByRole('button',{name:settings,exact:true}).click();
   await expect(page.getByLabel(language==='en'?'Language':'语言',{exact:true})).toHaveValue('system');
  }finally{await context.close();}
 });
}

test('save switches the full UI, returns compact, and does not touch credentials or AI',async({page})=>{
 await page.goto('/');await page.waitForFunction(()=>!!(window as any).__newsFloatTest);
 await page.evaluate(()=>{const h=(window as any).__newsFloatTest;(window as any).keyReads=0;(window as any).aiCalls=0;
  h.bridge.keyStatus=async()=>{(window as any).keyReads++;return true;};h.bridge.judgeBatch=async()=>{(window as any).aiCalls++;return [];};
 });
 const news=await page.locator('.ticker-copy').textContent();
 await page.locator('.ticker').click({button:'right',position:{x:40,y:15}});await page.getByRole('button',{name:'设置',exact:true}).click();
 await page.getByLabel('语言',{exact:true}).selectOption('en');
 // Preview is immediate; Save persists the choice.
 await expect(page.locator('html')).toHaveAttribute('lang','en');
 await page.getByRole('button',{name:'Save',exact:true}).click();await expect(page.locator('.pill')).toBeVisible();
 await expect(page.locator('html')).toHaveAttribute('lang','en');await expect(page).toHaveTitle('LingDongNews');
 expect(await page.locator('.ticker-copy').textContent()).toBe(news);
 await page.locator('.ticker').click({button:'right',position:{x:40,y:15}});
 await expect(page.getByRole('button',{name:'Read this story',exact:true})).toBeVisible();
 await page.getByRole('button',{name:'Settings',exact:true}).click();
 await expect(page.getByLabel('Language',{exact:true})).toHaveValue('en');
 expect(await page.evaluate(async()=>{const h=(window as any).__newsFloatTest;return{saved:(await h.bridge.load()).state.preferences.language,keys:(window as any).keyReads,calls:(window as any).aiCalls};})).toEqual({saved:'en',keys:0,calls:0});
 await page.getByLabel('Language',{exact:true}).selectOption('zh-CN');await expect(page.locator('html')).toHaveAttribute('lang','zh-CN');await page.getByRole('button',{name:'取消',exact:true}).click();
 await expect(page.locator('html')).toHaveAttribute('lang','en');
 await page.locator('.ticker').click({button:'right',position:{x:40,y:15}});await page.getByRole('button',{name:'Settings',exact:true}).click();
 await page.getByLabel('Language',{exact:true}).selectOption('zh-CN');await page.getByRole('button',{name:'保存',exact:true}).click();
 await expect(page.locator('html')).toHaveAttribute('lang','zh-CN');await expect(page).toHaveTitle('灵动新闻');
});

test('English reading and settings fit the supported window widths',async({browser,baseURL})=>{
 const context=await browser.newContext({locale:'en-US',baseURL,viewport:{width:480,height:700}});
 try{
  const page=await context.newPage();await page.goto('/');await page.waitForFunction(()=>!!(window as any).__newsFloatTest);
  for(const mode of ['glance','settings']){
   await page.evaluate(mode=>(window as any).__newsFloatTest.setMode(mode),mode);
   for(const width of [320,380,480]){
    await page.setViewportSize({width,height:700});
    const overflow=await page.evaluate(()=>{const nodes=[document.documentElement,...document.querySelectorAll<HTMLElement>('.panel-header,.settings-scroll,.settings-actions')];return nodes.filter(n=>n.scrollWidth>n.clientWidth+1).map(n=>n.className||'html');});
    expect(overflow,`${mode} at ${width}px`).toEqual([]);
    for(const target of ['.panel-header .collapse','.panel-header [data-ai-control]']){
     const b=await page.locator(target).boundingBox();if(b)expect(b.x+b.width).toBeLessThanOrEqual(width);
    }
   }
  }
  await page.setViewportSize({width:480,height:700});await page.getByLabel('Language',{exact:true}).scrollIntoViewIfNeeded();
  await page.screenshot({path:'/tmp/lingdong-language-settings-en.png'});
 }finally{await context.close();}
});

test('live language preview preserves draft keys, text, focus and disclosure state',async({page})=>{
 await page.goto('/');await page.waitForFunction(()=>!!(window as any).__newsFloatTest);
 await page.evaluate(()=>{const h=(window as any).__newsFloatTest;h.state().preferences.customSources.push({id:'custom:language',name:'保存',url:'https://example.invalid/feed',auth:'none',format:'auto'});h.state().preferences.sources.push('custom:language');return h.setMode('settings');});
 await page.getByLabel('关键词高亮',{exact:true}).check();await page.getByLabel('关注词（逗号或换行分隔）',{exact:true}).fill('保存，人工智能');
 await page.locator('.ai-settings > .settings-disclosure').first().locator(':scope > summary').click();
 await page.getByLabel('API Key',{exact:true}).fill('preview-only-unsaved-key');await page.getByLabel('我关注什么',{exact:true}).fill('关注模型的本地部署');
 const key=await page.getByLabel('API Key',{exact:true}).elementHandle();
 await page.getByLabel('语言',{exact:true}).focus();await page.getByLabel('语言',{exact:true}).selectOption('en');
 await expect(page.getByRole('button',{name:'Save',exact:true})).toBeVisible();await expect(page.getByLabel('Language',{exact:true})).toBeFocused();
 await expect(page.getByLabel('API Key',{exact:true})).toHaveValue('preview-only-unsaved-key');await expect(page.getByLabel('My interests',{exact:true})).toHaveValue('关注模型的本地部署');
 await expect(page.getByLabel('Keywords (separate with commas or new lines)',{exact:true})).toHaveValue('保存，人工智能');
 expect(await key!.evaluate(e=>e.isConnected)).toBe(true);
 await expect(page.getByRole('checkbox',{name:'保存',exact:true})).toBeChecked();await expect(page.locator('.channel-kind').first()).toHaveText('Built-in');
 await page.getByRole('button',{name:'Cancel',exact:true}).click();await expect(page.locator('html')).toHaveAttribute('lang','zh-CN');
 await page.evaluate(()=>(window as any).__newsFloatTest.setMode('settings'));await expect(page.getByLabel('API Key',{exact:true})).toHaveValue('');
});
