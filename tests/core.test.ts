import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cacheHash,acknowledge, deduplicate, defaults, emptyState, highlightMode, fingerprint, FollowController, isMatch, merge, parseFeed, sameStory, syncUnread, text, validEndpoint, visibleGroups, sourceName, validSourceURL, validateSources, type NewsItem, type Source } from '../src/core.ts';
const now = Date.now();
function item(body = '英伟达股价上涨超过3%，多家机构上调公司目标价。', source: Source = 'cls', id = '1', date = now): NewsItem { return { id: `${source}:${id}`, source, title: '', body, publishedAt: date, url: 'https://example.com', tags: [] }; }
test('highlights are opt-in and missing JEV configuration falls back without failure', () => {
  const prefs = defaults(); assert.equal(prefs.keywordEnabled, false); assert.equal(prefs.aiEnabled, false);
  prefs.keywords = '英伟达'; assert.equal(highlightMode(prefs, false).active, false);
  prefs.aiEnabled = true; assert.equal(highlightMode(prefs, false).label, '原始消息流');
  prefs.keywordEnabled = true; assert.equal(highlightMode(prefs, false).label, '关键词高亮');
  prefs.interests = '芯片'; assert.equal(highlightMode(prefs, true).label, '关键词 + AI 高亮');
  assert.equal(highlightMode(prefs, true, 'timeout').label, '关键词高亮');
});
test('highlighting never removes news; keyword and AI matches use a union', () => {
  const state = emptyState(); state.items = [item(), item('无关键词的其他消息', 'jin10', '2')];
  assert.equal(visibleGroups(state, false).length, 2);
  state.preferences.keywordEnabled = true; state.preferences.keywords = '英伟达';
  assert.equal(visibleGroups(state, false).length, 2);
  assert.equal(isMatch(state.items[0], state.preferences, false), true);
  assert.equal(isMatch(state.items[1], state.preferences, false), false);
  state.preferences.aiEnabled = true; state.preferences.interests = '其他';
  state.items[1].judgement = { probability: .99, model: 'test', fingerprint: fingerprint(state.items[1], state.preferences) };
  assert.equal(visibleGroups(state, true).length, 2);
  assert.equal(isMatch(state.items[1], state.preferences, true), true);
  state.preferences.interests = '改变后的关注点'; assert.equal(visibleGroups(state, true).length, 2);
  assert.equal(isMatch(state.items[1], state.preferences, true), false);
  assert.equal(visibleGroups(state, true, 'timeout').length, 2);
  assert.equal(visibleGroups(state, true, undefined, 'jin10').length, 1);
  assert.equal(visibleGroups(state, true, undefined, undefined, '无关键词').length, 1);
});
test('cross-source duplicates group full bodies and preserve all original links', () => {
  const a = item('财联社11月14日电，英伟达(NVDA.O)目标价上调至230美元，公司预计下一季度收入增长。');
  const b = item('金十数据11月14日讯，英伟达目标价上调至230美元，公司预计下一季度收入增长。', 'jin10');
  assert.equal(deduplicate([a,b]).length, 1); assert.equal(deduplicate([a,b])[0].members.length, 2);
});
test('changed numeric values, decimals, direction, corrections and distant repeats stay separate', () => {
  for (const [a,b] of [['股价上涨3.5%，机构目标价为230美元。','股价上涨35%，机构目标价为230美元。'], ['黄金价格上涨3%，市场反应明显。','黄金价格下跌3%，市场反应明显。'], ['公司已经批准收购交易并将推进计划。','更正：公司已经批准收购交易并将推进计划。']]) assert.equal(sameStory(item(a), item(b, 'jin10')), false);
  assert.equal(sameStory(item(), item(undefined,'jin10','1',now - 901_000)), false);
});
test('same ID correction replaces row and invalidates old AI result', () => {
  const original = item(); original.judgement = { probability:.9, model:'test', fingerprint:'old' };
  assert.ok(merge([original], [item()])[0].judgement);
  assert.equal(merge([original], [item('公司发布了更正后的新闻内容。')])[0].judgement, undefined);
});
test('read duplicate does not re-alert from another source; numeric update does', () => {
  const state = emptyState(); state.preferences.keywordEnabled = true; state.preferences.keywords = '股价';
  state.items = [item()]; syncUnread(state, false); assert.equal(state.unread.length, 1);
  acknowledge(state, deduplicate(state.unread)[0]);
  state.items = [item(undefined,'jin10')]; syncUnread(state, false); assert.equal(state.unread.length, 0);
  state.items.push(item('英伟达股价上涨超过4%，多家机构上调公司目标价。','jin10','2')); syncUnread(state, false); assert.equal(state.unread.length, 1);
});
test('unread remains visible after raw cache eviction', () => {
  const state = emptyState(); state.preferences.keywordEnabled = true; state.preferences.keywords = '股价'; state.items = [item()];
  syncUnread(state, false); state.items = []; assert.equal(visibleGroups(state, false).length, 1);
});
test('bounded cache preserves latest ID and stale feed does not grow indefinitely', () => {
  assert.equal(merge([], [item(undefined,'cls','old',now - 8 * 86400_000)]).length, 0);
  assert.equal(merge([], Array.from({length:1200}, (_,i) => item(undefined,'cls',String(i),now-i))).length, 1000);
});
test('one standard JSON consumer handles every adapter output without source-specific branches', () => {
  const feed=JSON.stringify({version:1,items:[{id:'one',title:'标题',body:'完整正文',publishedAt:now,tags:['新闻']}]});
  for(const source of ['cls','wallstreet','jin10','custom:rss','custom:json','custom:adapter']){const parsed=parseFeed(source,feed);assert.equal(parsed[0].body,'完整正文');assert.equal(parsed[0].id,`${source}:one`);assert.deepEqual(parsed[0].tags,['新闻']);}
  assert.throws(()=>parseFeed('jin10','var newest = alert(1)'));
});
test('endpoint rejects credentials, queries and external HTTP', () => {
  for (const url of ['http://external.test/api','https://key@api.test/x','https://api.test/x?key=secret','https://api.test/x#secret']) assert.equal(validEndpoint({...defaults().ai,apiUrl:url}),false);
  assert.equal(validEndpoint({...defaults().ai,apiUrl:'http://[::1]:8888/v1/chat/completions'}),true);
});
test('automatic follow pauses on hover, scrolling and selection and resumes after timeout', () => {
  const follow = new FollowController(); assert.equal(follow.canFollow(0),true);
  follow.hovering = true; assert.equal(follow.canFollow(100),false); follow.hovering = false;
  follow.manual(100); assert.equal(follow.canFollow(15099),false); assert.equal(follow.canFollow(15100),true);
  follow.selection = true; assert.equal(follow.canFollow(20000),false);
  follow.resume(); assert.equal(follow.canFollow(20000),true); follow.auto = false; assert.equal(follow.canFollow(30000),false);
});

test('standard news adapter preserves IDs, timestamps, tags and full text without source-importance inference',()=>{
  const prefs=defaults();prefs.customSources=[{id:'custom:mine',name:'我的接口',url:'http://127.0.0.1:8080/news?limit=50',auth:'none'}];prefs.sources=['custom:mine'];
  assert.equal(validateSources(prefs),undefined);assert.equal(sourceName('custom:mine',prefs),'我的接口');
  const parsed=parseFeed('custom:mine',JSON.stringify({version:1,items:[{id:'remote-1',title:'完整标题',body:'完整正文。<仅作文本展示>',publishedAt:now,url:'https://example.com/original',tags:['半导体','半导体','市场'],important:true}]}));
  assert.deepEqual(parsed[0].tags,['半导体','市场']);assert.equal(parsed[0].id,'custom:mine:remote-1');assert.equal(parsed[0].body,'完整正文。<仅作文本展示>');assert.equal(parsed[0].publishedAt,now);assert.equal('important' in parsed[0],false);
  const state=emptyState();state.preferences=prefs;state.items=parsed;assert.equal(visibleGroups(state,false).length,1);
});
test('standard news adapter rejects ambiguous dates, duplicate IDs, invalid tags and executable links atomically',()=>{
  const row={id:'a',body:'正文',publishedAt:now};
  for(const change of [{publishedAt:Math.floor(now/1000)},{publishedAt:'2026-11-15 08:30:00'},{url:'javascript:alert(1)'},{tags:['']},{tags:[1]},{body:''}])assert.throws(()=>parseFeed('custom:test',JSON.stringify({version:1,items:[row,{...row,id:'b',...change}]})));
  assert.throws(()=>parseFeed('custom:test',JSON.stringify({version:1,items:[row,row]})));
  assert.throws(()=>parseFeed('custom:test',JSON.stringify({version:2,items:[]})));
  const iso=new Date(now).toISOString();assert.equal(parseFeed('custom:test',JSON.stringify({version:1,items:[{...row,publishedAt:iso}]}))[0].publishedAt,now);
  assert.equal(parseFeed('custom:test',JSON.stringify({version:1,items:[]})).length,0);
});
test('custom source URL and IDs prevent credentials from being persisted or sources from colliding',()=>{
  for(const url of ['https://x.test/news?api_key=secret','https://key@x.test/feed','http://remote.test/feed','https://x.test/feed#key'])assert.equal(validSourceURL(url),false);
  assert.equal(validSourceURL('https://x.test/news?limit=100'),true);
  const prefs=defaults();prefs.customSources=[{id:'cls',name:'撞名',url:'https://example.com',auth:'none'}];assert.ok(validateSources(prefs));
});
test('JSON decisions use relevant directly, while JEV uses threshold; system prompt and tags invalidate the judgement',()=>{
  const prefs=defaults();prefs.interests='芯片';prefs.threshold=.99;const story=item();
  story.judgement={probability:.1,relevant:true,kind:'json',reason:'直接相关',tags:[],model:'test',fingerprint:fingerprint(story,prefs)};
  assert.equal(isMatch(story,prefs,true),true);story.judgement.kind='decision';assert.equal(isMatch(story,prefs,true),false);
  story.judgement.kind='json';prefs.ai.systemPrompt+='新的规则';assert.equal(isMatch(story,prefs,true),false);
  story.judgement.fingerprint=fingerprint(story,prefs);story.tags=['芯片'];assert.equal(isMatch(story,prefs,true),false);
});

test('undated subscription entries keep first discovery time instead of appearing new on every poll',()=>{
  const original={...item(),dateEstimated:true};const refreshed={...original,publishedAt:now+60000};
  assert.equal(merge([original],[refreshed])[0].publishedAt,now);
  assert.equal(merge([original],[{...refreshed,dateEstimated:false}])[0].publishedAt,now+60000);
});

test('fast fingerprints preserve all persisted Unicode cache identities',()=>{
 const legacy=(s:string)=>{let h=0xcbf29ce484222325n;for(const c of s)h=BigInt.asUintN(64,(h^BigInt(c.codePointAt(0)!))*0x100000001b3n);return h.toString(16);};
 let seed=42;for(let i=0;i<300;i++){let s='新闻\n"宏观政策"📰𠮷\u0000';for(let j=0;j<i;j++){seed=(Math.imul(seed,1664525)+1013904223)>>>0;s+=String.fromCodePoint(seed%0x110000);}assert.equal(cacheHash(s),legacy(s));}
});
