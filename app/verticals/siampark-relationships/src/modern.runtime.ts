import { isI18nInstance } from '@modern-js/plugin-i18n/i18n';
import { defineRuntimeConfig } from '@modern-js/runtime';
import { createInstance } from 'i18next';
import type { I18nInstance } from '@modern-js/plugin-i18n/runtime';
import { Result, Schema } from 'effect';

import csResource from '../locales/cs/siampark-relationships.json';
import enResource from '../locales/en/siampark-relationships.json';
import { ultramodernRouteNamespace } from './routes/ultramodern-route-metadata';

const i18nInstance = Result.getOrThrow(
  Schema.decodeUnknownResult(Schema.declare<I18nInstance>(isI18nInstance))(createInstance()),
);
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
