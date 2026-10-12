import { isI18nInstance } from '@modern-js/plugin-i18n/i18n';
import { defineRuntimeConfig } from '@modern-js/runtime';
import { createInstance } from 'i18next';
import { Schema } from 'effect';

import csResource from '../locales/cs/siampark-billing-finance.json';
import enResource from '../locales/en/siampark-billing-finance.json';
import { ultramodernRouteNamespace } from './routes/ultramodern-route-metadata';

class InvalidFinanceI18n extends Schema.TaggedError<InvalidFinanceI18n>()('InvalidFinanceI18n', {
  reason: Schema.String,
}) {}

const i18nInstance = createInstance();
if (!isI18nInstance(i18nInstance)) {
  throw new InvalidFinanceI18n({ reason: 'The configured i18n instance is incompatible with the Modern runtime' });
}
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
