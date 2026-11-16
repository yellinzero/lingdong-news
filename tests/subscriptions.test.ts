import {test} from 'node:test';
import assert from 'node:assert/strict';
import {previewSubscriptions,exportOPML} from '../src/subscriptions.ts';
import {defaults,validateSources} from '../src/core.ts';
test('bulk source preview handles names, duplicate URLs and malformed entries without silently merging distinct subscriptions',()=>{
  const prefs=defaults();prefs.customSources=[{id:'custom:existing',name:'已有源',url:'https://example.com/feed',auth:'none'}];
  const preview=previewSubscriptions('已有 | https://EXAMPLE.com:443/feed\n源A | https://a.test/rss\nhttps://b.test/atom\nhttps://a.test/rss\nhttps://bad.test/rss?key=secret',prefs);
  assert.equal(preview.sources.length,2);assert.equal(preview.duplicates,2);assert.equal(preview.issues.length,1);assert.equal(preview.sources[0].name,'源A');assert.notEqual(preview.sources[0].id,preview.sources[1].id);
  assert.equal(prefs.customSources.length,1);
});
test('local JSON adapter directories retain mapping rules without executable code or a hosted gateway',()=>{
  const adapter={itemsPath:'data.items',idPath:'id',bodyPaths:['text'],datePath:'time',dateUnit:'seconds'};
  const preview=previewSubscriptions(JSON.stringify({version:1,sources:[{name:'本地转换',url:'https://example.com/raw',format:'adapter',adapter}]}),defaults());
  assert.equal(preview.sources.length,1);assert.deepEqual(preview.sources[0].adapter,adapter);
  const bad=previewSubscriptions(JSON.stringify({version:1,sources:[{name:'坏规则',url:'https://example.com/raw',format:'adapter',adapter:{...adapter,idPath:'eval(1)'}}]}),defaults());assert.equal(bad.sources.length,0);assert.equal(bad.issues.length,1);
});
test('source import capacity is explicit and duplicate manual configurations are rejected',()=>{
  const prefs=defaults();prefs.customSources=Array.from({length:199},(_,i)=>({id:`custom:item-${i}`,name:'来源',url:`https://example.com/feed/${i}`,auth:'none'}));
  const preview=previewSubscriptions('https://one.test/rss\nhttps://two.test/rss',prefs);assert.equal(preview.sources.length,1);assert.match(preview.issues[0],/200/u);
  prefs.customSources.push({...prefs.customSources[0],id:'custom:duplicate'});assert.match(validateSources(prefs)!,/重复/u);
});
test('OPML export escapes metadata, preserves format and folders, and excludes adapter rules and keys',()=>{
  const exported=exportOPML([{id:'custom:rss',name:'A & "B"',url:'https://example.com/rss?q=1&limit=20',folder:'新闻 / 科技',format:'feed',auth:'none'},{id:'custom:adapter',name:'规则',url:'https://example.com/raw',format:'adapter',auth:'none'}]);
  assert.ok(exported.includes('A &amp; &quot;B&quot;'));assert.ok(exported.includes('q=1&amp;limit=20'));assert.ok(exported.includes('nf:format="feed"'));assert.ok(exported.includes('新闻 / 科技'));assert.ok(!exported.includes('example.com/raw'));assert.ok(!exported.includes('Key'));
});
