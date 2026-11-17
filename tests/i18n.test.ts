import {test,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {resolveLanguage,setLanguage,t,uiLocale,localizeMessage} from '../src/i18n';
import {english} from '../src/locales/en';
import {defaults,emptyState,fingerprint} from '../src/core';

afterEach(()=>setLanguage('system','zh-CN'));
test('system uses English only for English locales and Chinese for all other locales',()=>{
  for(const locale of ['en','en-US','EN_us.UTF-8']) assert.equal(resolveLanguage('system',locale),'en');
  for(const locale of ['zh-CN','zh-TW','ja-JP','fr-FR','de-DE','ar-SA','','english']) assert.equal(resolveLanguage('system',locale),'zh-CN');
  assert.equal(resolveLanguage('en','ja-JP'),'en');
  assert.equal(resolveLanguage('zh-CN','en-US'),'zh-CN');
  assert.equal(resolveLanguage(undefined,'en-US'),'en');
  assert.equal(defaults().language,'system');
});
test('translations preserve interpolation values and unknown content',()=>{
  setLanguage('en','zh-CN');assert.equal(uiLocale(),'en-US');
  assert.equal(t('搜索：{0}','新闻 {0} <script>'),'Search: 新闻 {0} <script>');
  assert.equal(t('安装{0}','我的来源'),'Install 我的来源');
  assert.equal(t('用户自己的新闻'),'用户自己的新闻');
  setLanguage('zh-CN','en-US');assert.equal(t('保存'),'保存');
});
test('English translations retain every interpolation parameter',()=>{
  const params=(s:string)=>[...s.matchAll(/\{\d+\}/gu)].map(m=>m[0]).sort();
  for(const [source,translation] of Object.entries(english)) assert.deepEqual(params(translation),params(source),source);
});
test('language changes never invalidate cached AI judgements or mutate user content',()=>{
  const s=emptyState();s.preferences.interests='开源 AI';s.preferences.ai.systemPrompt='我的提示词';
  const item={id:'cls:language',source:'cls',title:'标题',body:'正文',publishedAt:Date.now(),url:'',tags:['标签']};
  const before=fingerprint(item,s.preferences),prompt=s.preferences.ai.systemPrompt;
  s.preferences.language='en';assert.equal(fingerprint(item,s.preferences),before);assert.equal(s.preferences.ai.systemPrompt,prompt);
});

test('native errors translate for display without losing unknown provider details',()=>{
  setLanguage('en','zh-CN');
  assert.equal(localizeMessage('请求超时，将自动重试'),'Request timed out. Retrying automatically.');
  assert.equal(localizeMessage('模型接口返回 HTTP 422；请检查 URL、格式、JSON 模式和模型名称'),'Model endpoint returned HTTP 422. Check the URL, API format, JSON mode and model name.');
  assert.equal(localizeMessage('Provider detail: 原文'),'Provider detail: 原文');
});
