import {test,expect} from '@playwright/test';

for(const [locale,name] of [['zh-CN','灵动新闻'],['zh-TW','灵动新闻'],['en-US','LingDongNews']]){
  test(`system language ${locale} names the reader ${name}`,async({browser,baseURL})=>{
    const context=await browser.newContext({locale,baseURL});
    try{
      const page=await context.newPage();await page.goto('/');await page.waitForFunction(()=>!!(window as any).__newsFloatTest);
      await page.evaluate(()=>(window as any).__newsFloatTest.setMode('feed'));
      await expect(page.locator('.brand')).toHaveText(name);await expect(page).toHaveTitle(name);
    }finally{await context.close();}
  });
}
