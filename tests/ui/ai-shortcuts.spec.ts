import {test,expect} from '@playwright/test';

test.beforeEach(async({page})=>{await page.goto('/');await page.waitForFunction(()=>!!(window as any).__newsFloatTest);});

for(const origin of ['compact','glance','feed'])for(const action of ['保存','取消']){
  test(`settings ${action} returns to its ${origin} origin`,async({page})=>{
    await page.evaluate(async origin=>{const h=(window as any).__newsFloatTest;await h.setMode(origin);},origin);
    if(origin==='compact'){
      await page.locator('.ticker').click({button:'right',position:{x:40,y:15}});
      await page.getByRole('button',{name:'设置',exact:true}).click();
    }else await page.getByRole('button',{name:'设置',exact:true}).click();
    await page.getByRole('button',{name:action,exact:true}).click();
    await expect(page.locator(origin==='compact'?'.pill':`.${origin}`)).toBeVisible();
    expect(await page.evaluate(()=>(window as any).__newsFloatTest.window.mode)).toBe(origin);
  });
}

for(const format of ['decisions','chat','messages','responses']){
  test(`AI shortcut starts saved ${format} configuration without opening settings`,async({page})=>{
    await page.evaluate(format=>{const h=(window as any).__newsFloatTest,p=h.state().preferences;p.ai.format=format;p.interests='人工智能';p.aiEnabled=false;p.aiPaused=true;(window as any).keyReads=0;h.bridge.keyStatus=async(config:any)=>{(window as any).keyReads++;(window as any).startedFormat=config.format;return true;};},format);
    await page.locator('.ticker').click({button:'right',position:{x:40,y:15}});await page.getByRole('button',{name:'开启 AI',exact:true}).click();
    await expect.poll(()=>page.evaluate(()=>(window as any).__newsFloatTest.state().preferences.aiPaused)).toBe(false);
    await expect(page.locator('.pill')).toBeVisible();await expect(page.locator('.settings')).toHaveCount(0);
    expect(await page.evaluate(()=>({enabled:(window as any).__newsFloatTest.state().preferences.aiEnabled,format:(window as any).startedFormat,reads:(window as any).keyReads}))).toEqual({enabled:true,format,reads:1});
    await page.locator('.ticker').click({button:'right',position:{x:40,y:15}});await page.getByRole('button',{name:'关闭 AI',exact:true}).click();
    expect(await page.evaluate(()=>(window as any).__newsFloatTest.state().preferences.aiEnabled)).toBe(false);expect(await page.evaluate(()=>(window as any).keyReads)).toBe(1);
    await expect(page.locator('.pill')).toBeVisible();
  });
}

test('unconfigured shortcut opens AI settings and returns compact after cancel',async({page})=>{
  await page.locator('.ticker').click({button:'right',position:{x:40,y:15}});await page.getByRole('button',{name:'开启 AI',exact:true}).click();
  await expect(page.locator('.settings')).toBeVisible();await expect(page.getByLabel('模型名称')).toBeVisible();
  expect(await page.evaluate(()=>(window as any).__newsFloatTest.state().preferences.aiEnabled)).toBe(false);
  await page.getByRole('button',{name:'取消',exact:true}).click();await expect(page.locator('.pill')).toBeVisible();
});

test('missing saved key opens settings without starting AI requests',async({page})=>{
  await page.evaluate(()=>{const h=(window as any).__newsFloatTest;h.state().preferences.interests='人工智能';h.bridge.keyStatus=async()=>false;(window as any).calls=0;h.bridge.judgeBatch=async()=>{(window as any).calls++;return [];};});
  await page.locator('.ticker').click({button:'right',position:{x:40,y:15}});await page.getByRole('button',{name:'开启 AI',exact:true}).click();
  await expect(page.locator('.settings')).toBeVisible();expect(await page.evaluate(()=>(window as any).calls)).toBe(0);
  expect(await page.evaluate(()=>(window as any).__newsFloatTest.state().preferences.aiEnabled)).toBe(false);
});

test('closing AI while credential lookup is pending prevents a late automatic start',async({page})=>{
  await page.evaluate(()=>{const h=(window as any).__newsFloatTest;h.state().preferences.interests='人工智能';h.bridge.keyStatus=()=>new Promise(resolve=>(window as any).finishKey=()=>resolve(true));});
  await page.locator('.ticker').click({button:'right',position:{x:40,y:15}});await page.getByRole('button',{name:'开启 AI',exact:true}).click();
  await page.waitForFunction(()=>!!(window as any).finishKey);
  await page.locator('.ticker').click({button:'right',position:{x:40,y:15}});await page.getByRole('button',{name:'取消开启 AI',exact:true}).click();
  await page.evaluate(()=>(window as any).finishKey());await page.waitForTimeout(150);
  expect(await page.evaluate(()=>{const p=(window as any).__newsFloatTest.state().preferences;return {enabled:p.aiEnabled,paused:p.aiPaused};})).toEqual({enabled:false,paused:true});
  await expect(page.locator('.pill')).toBeVisible();
});

test('paused AI can be disabled with one click and without accessing credentials',async({page})=>{
  await page.evaluate(()=>{const h=(window as any).__newsFloatTest;Object.assign(h.state().preferences,{aiEnabled:true,aiPaused:true,interests:'科技'});h.bridge.keyStatus=async()=>{throw Error('Close must not access credentials');};return h.setMode('feed');});
  await page.getByRole('button',{name:'AI 已暂停 · 关闭',exact:true}).click();
  await expect(page.getByRole('button',{name:'开启 AI',exact:true})).toBeVisible();await expect(page.locator('.settings')).toHaveCount(0);
  expect(await page.evaluate(()=>(window as any).__newsFloatTest.state().preferences.aiEnabled)).toBe(false);
});
