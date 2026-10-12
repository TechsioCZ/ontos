import { Schema } from 'effect';
import { isI18nInstance } from '@modern-js/plugin-i18n/i18n';
import { defineRuntimeConfig } from '@modern-js/runtime';
import { createInstance } from 'i18next';

import csResource from '../locales/cs/siampark-occupancy.json';
import enResource from '../locales/en/siampark-occupancy.json';
import { ultramodernRouteNamespace } from './routes/ultramodern-route-metadata';

class RuntimeConfigurationError extends Schema.TaggedError<RuntimeConfigurationError>()('RuntimeConfigurationError', {
  reason: Schema.String,
}) {}
const i18nInstance = createInstance();
// The published SDK guard verifies its plugin adapter instead of a narrowed assertion.
if (!isI18nInstance(i18nInstance)) {
  throw new RuntimeConfigurationError({ reason: 'Unsupported i18next runtime instance' });
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
