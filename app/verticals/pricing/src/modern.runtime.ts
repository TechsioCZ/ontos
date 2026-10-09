import { assertI18nInstance } from '@modern-js/plugin-i18n/i18n';
import { defineRuntimeConfig } from '@modern-js/runtime';
import { createInstance } from 'i18next';

import csResource from '../locales/cs/pricing.json';
import enResource from '../locales/en/pricing.json';

const i18nInstance = createInstance();
assertI18nInstance(i18nInstance);
const resources = {
  cs: { api: csResource },
  en: { api: enResource },
} as const;

export default defineRuntimeConfig({
  i18n: {
    i18nInstance,
    initOptions: {
      defaultNS: 'api',
      fallbackLng: 'en',
      interpolation: {
        escapeValue: false,
      },
      ns: ['api', 'translation'],
      resources,
      supportedLngs: ['en', 'cs'],
    },
  },
  router: {
    framework: 'tanstack',
  },
});
