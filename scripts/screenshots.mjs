import {mkdirSync} from 'node:fs';import {join} from 'node:path';import {fileURLToPath,pathToFileURL} from 'node:url';import {createRequire} from 'node:module';
const root=fileURLToPath(new URL('..',import.meta.url)),require=createRequire(join(root,'package.json'));
const {createServer}=await import(pathToFileURL(require.resolve('vite')).href),{webkit}=require('@playwright/test');
const version=(await import('./version.mjs')).checkVersion(),out=join(root,'docs/assets',`v${version}`);mkdirSync(out,{recursive:true});
const server=await createServer({root,server:{host:'127.0.0.1',port:0,strictPort:true}});let browser;
try{
 await server.listen();const origin=`http://127.0.0.1:${server.httpServer.address().port}`;
 browser=await webkit.launch();const page=await browser.newPage({viewport:{width:460,height:34},deviceScaleFactor:2,locale:'zh-CN',timezoneId:'Asia/Shanghai'}),errors=[];
 page.on('pageerror',error=>errors.push(error.message));await page.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
 await page.goto(origin);await page.waitForFunction(()=>!!window.__newsFloatTest);await page.clock.install({time:new Date('2026-11-16T09:32:08+08:00')});await page.clock.pauseAt(new Date('2026-11-16T09:32:09+08:00'));
 const capture=async(name)=>{if(await page.locator('input[type=password]').evaluateAll(inputs=>inputs.some(input=>input.value)))throw Error('Screenshot contains a password field value');await page.clock.runFor(160);const appearance=await page.evaluate(()=>[document.documentElement.dataset.theme,document.documentElement.dataset.accent]);if(appearance[0]!=='dark'||appearance[1]!=='orange')throw Error(`Inconsistent screenshot theme in ${name}`);const bounds=await page.locator('.panel-header').evaluateAll(nodes=>nodes.map(node=>({width:node.clientWidth,scroll:node.scrollWidth})));if(bounds.some(b=>b.scroll>b.width+1))throw Error(`Header overflow in ${name}: ${JSON.stringify(bounds)}`);await page.screenshot({omitBackground:true,animations:'disabled'});await page.clock.runFor(34);await page.screenshot({path:join(out,`${name.endsWith('-dark')?name:`${name}-dark`}.png`),omitBackground:true,animations:'disabled'});};
 const seed=async()=>page.evaluate(()=>{
  const h=window.__newsFloatTest,s=h.state();s.items=[];s.unread=[];s.readStories=[];s.analysisPending=[];s.analysisHistory=[];s.playbackHistory=[];
  Object.assign(s.preferences,{theme:'dark',accent:'orange',keywordEnabled:true,keywords:'推理芯片，利率',aiEnabled:false,aiPaused:true,interests:'',autoScroll:true,skipPlayed:true,sources:['custom:demo-tech','custom:demo-market'],customSources:[{id:'custom:demo-tech',name:'演示科技',format:'json',url:'https://example.invalid/tech',auth:'none'},{id:'custom:demo-market',name:'演示财经',format:'json',url:'https://example.invalid/market',auth:'none'}]});
  Object.assign(s.preferences.aiLimits,{requestWindowMinutes:1,maxRequestsPerMinute:6,lookbackMinutes:30,newOnly:true});
  document.documentElement.dataset.theme='dark';document.documentElement.dataset.accent=s.preferences.accent;
  h.add([
   {id:'custom:demo-tech:1',source:'custom:demo-tech',title:'推理芯片团队公布新一代计算方案',body:'【推理芯片团队公布新一代计算方案】研发团队介绍了新方案的计算能力、能耗和开放测试计划。公开测试预计在下季度开始，具体性能将在完整测试后公布。新方案面向本地推理和边缘设备，支持常见模型的部署与调试。开发者可以按设备类型选择测试环境，后续将逐步开放软件工具和技术资料。',publishedAt:Date.now(),url:'',tags:['硬件']},
   {id:'custom:demo-market:2',source:'custom:demo-market',title:'本周经济日历更新',body:'本周将公布多项经济数据。公开日历已补充发布时间与预期值，读者可查看自己关注的指标。',publishedAt:Date.now()-65000,url:'',tags:['宏观']},
   {id:'custom:demo-market:3',source:'custom:demo-market',title:'关注即将公布的利率决议',body:'【关注即将公布的利率决议】市场正在等待最新政策说明。除了利率水平，声明中的通胀判断、就业评估和后续安排也是关注重点。相关数据发布后，后续快讯将继续更新。',publishedAt:Date.now()-132000,url:'',tags:['政策']},
   {id:'custom:demo-tech:4',source:'custom:demo-tech',title:'开源推理工具新增本地部署支持',body:'开发团队发布了本地部署工具，支持在个人设备上导入模型、查看运行状态并调整资源使用。项目同时提供安装说明和可复现的测试示例。',publishedAt:Date.now()-201000,url:'',tags:['开源']},
   {id:'custom:demo-market:5',source:'custom:demo-market',title:'城市公共交通调整周末服务时刻',body:'部分线路将调整周末发车间隔，具体时刻表可在运营方公开页面查询。',publishedAt:Date.now()-260000,url:'',tags:['交通']}
  ]);h.setAIStatus(false);return h.setMode('compact');
 });
 await seed();await page.mouse.move(-10,-10);await capture('compact');
 await page.setViewportSize({width:480,height:740});await page.evaluate(()=>{const h=window.__newsFloatTest;return h.openCurrentStory(h.groups()[0]);});await capture('reader-expanded-dark');
 await seed();await page.evaluate(()=>window.__newsFloatTest.setMode('feed'));for(const control of await page.getByRole('button',{name:'收起全文',exact:true}).all())await control.click();await capture('keyword-result');
 await page.evaluate(()=>window.__newsFloatTest.setMode('settings'));await page.setViewportSize({width:480,height:500});await page.locator('.keyword-fields').evaluate(node=>node.closest('.settings-section').scrollIntoView({block:'start'}));await capture('keyword-settings');await page.setViewportSize({width:480,height:740});
 await seed();await page.evaluate(async()=>{
  const h=window.__newsFloatTest,s=h.state();Object.assign(s.preferences,{keywordEnabled:false,aiEnabled:true,aiPaused:true,interests:'关注端侧推理硬件与开源模型部署，忽略宏观数据和交通新闻。'});s.preferences.aiLimits.newOnly=false;s.preferences.aiLimits.lookbackMinutes=1440;h.setAIStatus(true);
  const jobs=await h.aiClient.plan(true);if(jobs.length!==5)throw Error('Expected five demo AI jobs');
  await h.aiClient.apply(jobs.map(job=>({key:job.key,judgement:{kind:'decision',probability:job.item.source==='custom:demo-tech'?(job.item.body.includes('芯片')?.93:.89):.08,model:s.preferences.ai.model,fingerprint:job.key}})),true);
  return h.setMode('feed');
 });await capture('ai-result');
 await page.evaluate(()=>window.__newsFloatTest.setMode('settings'));await page.locator('.ai-settings').evaluate(node=>node.scrollIntoView({block:'start'}));await capture('ai-settings');
 await page.getByLabel('请求频控窗口',{exact:true}).selectOption('15');await page.getByLabel('窗口内最多请求（次）',{exact:true}).fill('6');await page.evaluate(()=>{const h=window.__newsFloatTest;Object.assign(h.aiUsage(),{items:8,requests:1});h.setAIStatus(true);});await page.locator('.ai-safety').evaluate(node=>node.scrollIntoView({block:'start'}));await capture('ai-limits');
 await seed();await page.evaluate(()=>{const h=window.__newsFloatTest;Object.assign(h.state().preferences,{sources:['cls','wallstreet','jin10'],customSources:[]});return h.setMode('settings');});await page.getByText('添加新闻来源',{exact:true}).click();await page.getByRole('button',{name:'添加来源',exact:true}).click();const custom=page.getByRole('region',{name:'自定义来源',exact:true});await custom.getByLabel('来源名称',{exact:true}).fill('我的 RSS');await custom.getByLabel('订阅或接口 URL',{exact:true}).fill('https://example.com/news/rss.xml');await page.locator('.installed-channels').evaluate(node=>node.closest('.settings-section').scrollIntoView({block:'start'}));await capture('sources-settings');
 if(errors.length)throw Error(errors.join('\n'));console.log(`Wrote eight feature screenshots to docs/assets/v${version}; isolated demo data, no model calls.`);
}finally{await browser?.close();await server.close();}
