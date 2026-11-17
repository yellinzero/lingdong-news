import { resolveLanguage } from './i18n';
export function nameForLocale(locale: string): string {
  return resolveLanguage('system', locale) === 'en' ? 'LingDongNews' : '灵动新闻';
}
