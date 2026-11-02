import { createI18n } from 'vue-i18n';

import en from './en.json';
import zhCN from './zh-CN.json';

export type Locale = 'en' | 'zh-CN';
type MessagePaths<T> = {
  [K in keyof T & string]: T[K] extends string
    ? K
    : `${K}.${MessagePaths<T[K]>}`;
}[keyof T & string];
export type MessageKey = MessagePaths<typeof en>;
type Parameters = Record<string, string | number>;
export interface Message {
  key: MessageKey;
  params?: Parameters;
}

const messages: Record<Locale, typeof en> = { en, 'zh-CN': zhCN };
export const i18n = createI18n({
  legacy: false,
  locale: 'en' as Locale,
  fallbackLocale: 'en',
  messages,
});

export function t(key: MessageKey, params: Parameters = {}): string {
  return i18n.global.t(key, params);
}
export function message(key: MessageKey, params?: Parameters): Message {
  return params ? { key, params } : { key };
}
export function translate(value: Message | '' | undefined): string {
  return value ? t(value.key, value.params) : '';
}

// Keep the descriptor with the error so an already visible failure can change language.
export class LocalizedError extends Error {
  constructor(readonly text: Message) {
    super(translate(text));
  }
}
export function errorMessage(reason: unknown, fallback: MessageKey): Message {
  return reason instanceof LocalizedError ? reason.text : message(fallback);
}
