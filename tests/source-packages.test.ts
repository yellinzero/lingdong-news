import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {defaults,validateSources} from '../src/core.ts';
import {preinstalledPackages,validatePackage,packageSource} from '../src/source-packages.ts';
import {exportChannelDirectory,installationCount,previewSubscriptions} from '../src/subscriptions.ts';
import {installChannel,uninstallChannel} from '../src/channels.ts';

test('preinstalled sources are the exact independently distributable manifest and script examples',()=>{
  for(const p of preinstalledPackages){
    const directory=new URL(`../source-adapters/packages/${p.manifest.id}/`,import.meta.url);
    assert.deepEqual(p.manifest,JSON.parse(readFileSync(new URL('manifest.json',directory),'utf8')),'Repack preinstalled.json after changing source manifests');
    assert.equal(p.script,readFileSync(new URL('adapter.js',directory),'utf8'),'Repack preinstalled.json after changing adapters');
    assert.equal(validatePackage(p),undefined);assert.equal(p.manifest.apiVersion,1);assert.ok(p.script.includes('function fetch(ctx)'));
  }
});
test('a renamed copy of the CLS example installs as a user plugin without changing its request or signing script',()=>{
  const p=structuredClone(preinstalledPackages[0]);p.manifest.id='custom:my-cls';p.manifest.name='用户财联社渠道';
  const prefs=defaults();let preview=previewSubscriptions(JSON.stringify({version:2,sources:[p]}),prefs);
  assert.equal(installationCount(preview),1);assert.equal(preview.sources[0].format,'plugin');assert.equal(preview.sources[0].plugin!.script,preinstalledPackages[0].script);
  prefs.customSources.push(...preview.sources);installChannel(prefs,p.manifest.id);assert.equal(validateSources(prefs),undefined);
  uninstallChannel(prefs,p.manifest.id);preview=previewSubscriptions(JSON.stringify({version:2,sources:[p]}),prefs);assert.deepEqual(preview.reinstalls,[p.manifest.id]);assert.equal(preview.sources.length,0);
});
test('plugin updates are explicit, preserve compatible configuration, reject downgrades and round-trip complete executable packages',()=>{
  const p=structuredClone(preinstalledPackages[1]);p.manifest.id='custom:updates';p.manifest.config=[{key:'channel',label:'频道',kind:'string',default:'market',required:true}];
  const prefs=defaults(),source=packageSource(p);source.parameters!.channel='technology';prefs.customSources.push(source);installChannel(prefs,source.id);
  let preview=previewSubscriptions(JSON.stringify({version:2,sources:[p]}),prefs);assert.equal(installationCount(preview),0);assert.equal(preview.duplicates,1);
  p.manifest.version='1.1.0';preview=previewSubscriptions(JSON.stringify({version:2,sources:[p]}),prefs);assert.equal(preview.updates.length,1);assert.equal(preview.updates[0].parameters!.channel,'technology');assert.equal(source.plugin!.manifest.version,'1.0.0');
  p.manifest.version='0.9.0';preview=previewSubscriptions(JSON.stringify({version:2,sources:[p]}),prefs);assert.equal(installationCount(preview),0);assert.match(preview.issues[0],/低版本/);
  const exported=JSON.parse(exportChannelDirectory(prefs));assert.equal(exported.version,2);assert.equal(exported.sources[0].script,preinstalledPackages[0].script);
  const imported=previewSubscriptions(JSON.stringify(exported),defaults());assert.equal(imported.sources.length,1);assert.equal(imported.sources[0].parameters!.channel,'technology');assert.equal(validatePackage(imported.sources[0].plugin),undefined);
});
test('unknown capabilities, wildcard hosts, prototype parameter keys, wrong API versions and ambiguous duplicate IDs do not silently install',()=>{
  for(const mutate of [
    (p:any)=>p.manifest.apiVersion=9,
    (p:any)=>p.manifest.network=['https://*.example.com'],
    (p:any)=>p.manifest.network=['https://example.com/path'],
    (p:any)=>p.manifest.filesystem=true,
    (p:any)=>p.manifest.config=[{key:'__proto__',label:'bad',kind:'string',default:'x'}]
  ]){const p=structuredClone(preinstalledPackages[0]);mutate(p);const preview=previewSubscriptions(JSON.stringify({version:2,sources:[p]}),defaults());assert.equal(installationCount(preview),0);assert.ok(preview.issues.length);}
  const p=structuredClone(preinstalledPackages[0]);p.manifest.id='custom:duplicate';const preview=previewSubscriptions(JSON.stringify({version:2,sources:[p,p]}),defaults());assert.equal(installationCount(preview),1);assert.ok(preview.issues.length);
});
