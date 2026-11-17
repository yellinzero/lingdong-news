import {test} from 'node:test';
import assert from 'node:assert/strict';
import {nameForLocale} from '../src/branding';

test('English systems use LingDongNews; other languages default to 灵动新闻',()=>{
  for(const locale of ['zh','zh-CN','zh-Hans-CN','zh-Hant-TW','zh_CN.UTF-8','ZH-hk','ja-JP','de-DE','','zhong'])assert.equal(nameForLocale(locale),'灵动新闻');
  for(const locale of ['en','en-US','en_GB','EN-us'])assert.equal(nameForLocale(locale),'LingDongNews');
});
