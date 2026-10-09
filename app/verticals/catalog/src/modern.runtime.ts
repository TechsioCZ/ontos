import { assertI18nInstance } from '@modern-js/plugin-i18n/i18n';
import { defineRuntimeConfig } from '@modern-js/runtime';
import { createInstance } from 'i18next';

import csResource from '../locales/cs/catalog.json';
import enResource from '../locales/en/catalog.json';
import { ultramodernRouteNamespace } from './routes/ultramodern-route-metadata';

const i18nInstance = createInstance();
assertI18nInstance(i18nInstance);
const resources = {
  cs: { [ultramodernRouteNamespace]: csResource },
  en: { [ultramodernRouteNamespace]: enResource },
} as const;

export default defineRuntimeConfig({
  i18n: {
    i18nInstance,
    initOptions: {
      defaultNS: ultramodernRouteNamespace,
      fallbackLng: 'en',
      interpolation: {
        escapeValue: false,
      },
      ns: [ultramodernRouteNamespace, 'translation'],
      resources,
      supportedLngs: ['en', 'cs'],
    },
  },

  router: {
    framework: 'tanstack',
  },
});
