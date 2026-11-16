import {test} from 'node:test';
import assert from 'node:assert/strict';
import {nameForLocale} from '../src/branding';

test('Chinese system languages use 灵动新闻; other languages use LingDongNews',()=>{
  for(const locale of ['zh','zh-CN','zh-Hans-CN','zh-Hant-TW','zh_CN.UTF-8','ZH-hk'])assert.equal(nameForLocale(locale),'灵动新闻');
  for(const locale of ['en-US','en_GB','ja-JP','de-DE','','zhong'])assert.equal(nameForLocale(locale),'LingDongNews');
});
