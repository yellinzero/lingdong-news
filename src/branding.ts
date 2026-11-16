export function nameForLocale(locale: string): string {
  return locale.split(/[-_.]/u)[0].toLowerCase() === 'zh' ? '灵动新闻' : 'LingDongNews';
}
