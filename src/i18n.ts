import { english } from './locales/en';

export type Language = 'zh-CN' | 'en';
export type LanguagePreference = 'system' | Language;
export function resolveLanguage(preference: string | undefined, systemLocale: string): Language {
  if (preference === 'en' || preference === 'zh-CN') return preference;
  return systemLocale.split(/[-_.]/u)[0].toLowerCase() === 'en' ? 'en' : 'zh-CN';
}
let language: Language = resolveLanguage('system', typeof window === 'undefined' ? '' : navigator.language);
export function setLanguage(preference: string | undefined, systemLocale: string): Language {
  return language = resolveLanguage(preference, systemLocale);
}
export function uiLocale(): string { return language === 'en' ? 'en-US' : 'zh-CN'; }
export function t(message: string, ...values: (string | number)[]): string {
  const copy = language === 'en' ? english[message] ?? message : message;
  return copy.replace(/\{(\d+)\}/gu, (placeholder, index) => values[Number(index)] === undefined ? placeholder : String(values[Number(index)]));
}

// Translate display errors, retaining raw errors for retry and safety decisions.
// Unknown provider details remain intact.
const errorPatterns = Object.keys(english).filter(key => /\{\d+\}/u.test(key)).map(key => {
  const parts = key.split(/(\{\d+\})/u), indexes: number[] = [];
  const pattern = parts.map(part => {
    const placeholder = /^\{(\d+)\}$/u.exec(part);
    if (placeholder) { indexes.push(Number(placeholder[1])); return '([\\s\\S]*?)'; }
    return part.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  }).join('');
  return { key, indexes, pattern: new RegExp(`^${pattern}$`, 'u') };
});
export function localizeMessage(message: string): string {
  if (language !== 'en') return message;
  if (Object.hasOwn(english, message)) return t(message);
  for (const { key, indexes, pattern } of errorPatterns) {
    const match = pattern.exec(message);
    if (match) {
      const values: string[] = [];
      indexes.forEach((index, capture) => { values[index] = match[capture + 1]; });
      return t(key, ...values);
    }
  }
  return message;
}
