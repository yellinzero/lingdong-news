import {test,expect} from '@playwright/test';
test.beforeEach(async({page})=>{await page.goto('/');await page.waitForFunction(()=>!!(window as any).__newsFloatTest);});
for(const kind of ['json','decision'])test(`closing AI preserves ${kind} highlights and persisted results without credentials`,async({page})=>{
 await page.evaluate(async kind=>{const h=(window as any).__newsFloatTest,s=h.state();s.items=[];s.unread=[];s.analysisPending=[];s.analysisHistory=[];Object.assign(s.preferences,{aiEnabled:true,aiPaused:false,interests:'科技',keywordEnabled:false});s.preferences.aiLimits.newOnly=false;h.setAIStatus(true);
  (window as any).paidCalls=0;h.bridge.judgeBatch=async()=>{(window as any).paidCalls++;return [];};h.bridge.keyStatus=async()=>{throw Error('Closing AI read credentials');};h.bridge.save=async(state:any)=>{(window as any).savedHistory=JSON.parse(JSON.stringify(state));};
  // The highlighted story is always newest, even if fixture creation crosses a millisecond.
  const now=Date.now();h.add([1,2].map(n=>({id:`cls:cache-${n}`,source:'cls',title:'',body:`科技公司研发项目 ${n} 进入新阶段。`,publishedAt:now-n*1000,url:'',tags:[]})));
  const jobs=await h.aiClient.plan(true);await h.aiClient.apply(jobs.map((job:any)=>({key:job.key,judgement:{kind,relevant:job.item.body.includes(' 1 '),probability:job.item.body.includes(' 1 ')?0.95:0.1,reason:'关注研发进展',model:'mock',fingerprint:job.key}})),true);
  await h.setMode('feed');
 },kind);
 await expect(page.locator('article.matched')).toHaveCount(1);await expect.poll(()=>page.evaluate(()=>(window as any).savedHistory?.analysisHistory?.length)).toBe(2);
 await page.getByRole('button',{name:'关闭 AI',exact:true}).click();await expect(page.locator('article.matched')).toHaveCount(1);await expect(page.locator('.ai-match')).toHaveCount(1);
 await page.locator('.reading-tools-summary').click();await expect(page.locator('.filter-label')).toHaveText('已有 AI 标记');
 await page.getByRole('button',{name:'收起',exact:true}).click();await expect(page.locator('.ticker-copy')).toHaveClass(/matched/);
 const disk=await page.evaluate(()=>(window as any).savedHistory);expect(disk.preferences.aiEnabled).toBe(false);expect(disk.analysisHistory).toHaveLength(2);expect(await page.evaluate(()=>(window as any).paidCalls)).toBe(0);
 // Recreate the app context, restore its disk JSON, and republish after raw-cache eviction.
 await page.reload();await page.waitForFunction(()=>!!(window as any).__newsFloatTest);
 await page.evaluate(async disk=>{const h=(window as any).__newsFloatTest;Object.assign(h.state(),disk);const s=h.state();s.items=[];s.unread=[];s.readStories=[];s.analysisPending=[];
  s.preferences.aiStartedAt=Date.now()+60000;s.preferences.aiLimits.newOnly=true;
  h.add([1,2].map(n=>({id:`jin10:repost-${n}`,source:'jin10',title:'',body:`科技公司研发项目 ${n} 进入新阶段。`,publishedAt:Date.now(),url:'',tags:[]})));
  const jobs=await h.aiClient.plan(false);(window as any).restoredJobs=jobs.length;await h.setMode('feed');
 },disk);
 expect(await page.evaluate(()=>(window as any).restoredJobs)).toBe(0);await expect(page.locator('article.matched')).toHaveCount(1);
 expect(await page.evaluate(()=>(window as any).__newsFloatTest.state().items.every((item:any)=>!!item.judgement))).toBe(true);
});

test('request window and count save independently from recency and explain uniform pacing',async({page})=>{
 await page.evaluate(async()=>{const h=(window as any).__newsFloatTest;h.state().preferences.aiEnabled=true;await h.setMode('feed');await h.setMode('settings');});
 await page.getByLabel('请求频控窗口',{exact:true}).selectOption('15');await page.getByLabel('窗口内最多请求（次）',{exact:true}).fill('6');await expect(page.locator('.ai-cadence')).toContainText('150 秒');
 await page.getByRole('button',{name:'保存',exact:true}).click();
 expect(await page.evaluate(()=>{const l=(window as any).__newsFloatTest.state().preferences.aiLimits;return {window:l.requestWindowMinutes,count:l.maxRequestsPerMinute,recency:l.lookbackMinutes};})).toEqual({window:15,count:6,recency:30});
});
