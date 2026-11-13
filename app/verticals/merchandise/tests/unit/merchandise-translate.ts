// The Merchandise locales through a real i18next instance, so a test reads interpolated text as a user sees it.
import { createInstance } from 'i18next';
import csLocale from '../../locales/cs/merchandise.json';
import enLocale from '../../locales/en/merchandise.json';

const i18n = createInstance({
  fallbackLng: false,
  initAsync: false,
  interpolation: { escapeValue: false },
  lng: 'cs',
  resources: { cs: { translation: csLocale }, en: { translation: enLocale } },
});
await i18n.init();

type Values = Readonly<Record<string, number | string>>;

/** `t` of one language; a missing key comes back as the key. */
export const translateIn =
  (language: 'cs' | 'en') =>
  (key: string, values: Values = {}): string =>
    i18n.t(key, { ...values, lng: language });

export const translateCs = translateIn('cs');

/**
 * The VAT words (`merchandise.tax.*`) in Czech; every other key stays a key, so the suites that assert on keys keep
 * doing so.
 */
export const translateTaxCs = (key: string, values: Values = {}): string =>
  key.startsWith('merchandise.tax.') ? translateCs(key, values) : key;
