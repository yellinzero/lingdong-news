import {test} from 'node:test';
import assert from 'node:assert/strict';
import {defaults,emptyState,visibleGroups,validateSources,allSources} from '../src/core.ts';
import {installChannel,uninstallChannel,enableChannel,isInstalled} from '../src/channels.ts';
import {exportChannelDirectory,installationCount,previewSubscriptions} from '../src/subscriptions.ts';

test('preinstalled and user channels have identical disable, uninstall and reinstall semantics without deleting news',()=>{
  const state=emptyState(),prefs=state.preferences;
  const source={id:'custom:author-news',name:'作者渠道',url:'https://example.com/news',auth:'none' as const,format:'json' as const};
  prefs.customSources.push(source);installChannel(prefs,source.id);
  state.items=[{id:'cls:one',source:'cls',title:'',body:'保留原始快讯正文',publishedAt:Date.now(),url:''}];
  for(const id of ['cls',source.id]){
    assert.ok(isInstalled(prefs,id));enableChannel(prefs,id,false);assert.ok(isInstalled(prefs,id));assert.ok(!prefs.sources.includes(id));
    uninstallChannel(prefs,id);assert.ok(!isInstalled(prefs,id));assert.ok(!prefs.sources.includes(id));assert.throws(()=>enableChannel(prefs,id,true));
    installChannel(prefs,id);installChannel(prefs,id);assert.ok(isInstalled(prefs,id));assert.equal(prefs.sources.filter(x=>x===id).length,1);
  }
  assert.equal(state.items.length,1);assert.deepEqual(prefs.customSources,[source]);
  assert.equal(visibleGroups(state,false).length,1);assert.equal(validateSources(prefs),undefined);
});
test('all channels may be uninstalled and an empty collection remains a valid saved state',()=>{
  const prefs=defaults();for(const id of [...allSources(prefs)])uninstallChannel(prefs,id);
  assert.deepEqual(prefs.sources,[]);assert.deepEqual(allSources(prefs),[]);assert.equal(validateSources(prefs),undefined);
  const restored=JSON.parse(JSON.stringify(prefs));assert.equal(isInstalled(restored,'cls'),false);
  installChannel(restored,'cls');assert.deepEqual(restored.sources,['cls']);
  assert.match(validateSources({...prefs,sources:['cls']})!,/无效/u);
  assert.match(validateSources({...prefs,uninstalledSources:['nonexistent']})!,/记录无效/u);
});
test('one manifest installs builtins and custom logic, keeps publisher IDs and restores by ID or URL without duplication',()=>{
  const prefs=defaults();uninstallChannel(prefs,'cls');
  const entry={id:'custom:acme-finance',name:'自定义逻辑源',url:'https://example.com/raw',format:'adapter',adapter:{itemsPath:'data.items',idPath:'id',bodyPaths:['body'],datePath:'time',dateUnit:'seconds'}};
  const manifest=JSON.stringify({version:1,sources:[{builtin:'cls'},entry]});
  let preview=previewSubscriptions(manifest,prefs);assert.equal(installationCount(preview),2);assert.deepEqual(preview.reinstalls,['cls']);assert.equal(preview.sources[0].id,entry.id);
  prefs.customSources.push(...preview.sources);for(const id of [...preview.reinstalls,...preview.sources.map(s=>s.id)])installChannel(prefs,id);
  preview=previewSubscriptions(manifest,prefs);assert.equal(installationCount(preview),0);assert.equal(preview.duplicates,2);
  uninstallChannel(prefs,entry.id);preview=previewSubscriptions(manifest,prefs);assert.equal(preview.sources.length,0);assert.deepEqual(preview.reinstalls,[entry.id]);
  assert.equal(prefs.customSources.length,1);assert.deepEqual(prefs.customSources[0].adapter,entry.adapter);
  const exported=JSON.parse(exportChannelDirectory(prefs));assert.ok(exported.sources.some((s:any)=>s.manifest?.id==='cls'));assert.ok(!exported.sources.some((s:any)=>s.id===entry.id));
  installChannel(prefs,entry.id);assert.ok(JSON.parse(exportChannelDirectory(prefs)).sources.some((s:any)=>s.id===entry.id));
});
test('channel manifests reject ID collisions, unknown builtins and executable code rather than silently changing an installed channel',()=>{
  const prefs=defaults();prefs.customSources=[{id:'custom:stable',name:'原渠道',url:'https://example.com/one',auth:'none'}];
  for(const entry of [{id:'custom:stable',name:'冲突',url:'https://example.com/two'},{builtin:'missing'},{builtin:'cls',url:'https://evil.example'},{name:'脚本',url:'https://example.com/a',script:'execute()'}]){
    const preview=previewSubscriptions(JSON.stringify({version:1,sources:[entry]}),prefs);assert.equal(installationCount(preview),0);assert.ok(preview.issues.length);
  }
  assert.equal(prefs.customSources[0].url,'https://example.com/one');
});
