import { defineRuntimeConfig } from '@modern-js/runtime';
import { createInstance } from 'i18next';

import { crmI18nResources } from './i18n/resources';
import { ultramodernRouteNamespace } from './routes/ultramodern-route-metadata';

const i18nInstance = createInstance();

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
      resources: crmI18nResources,
      supportedLngs: ['en', 'cs'],
    },
  },

  router: {
    framework: 'tanstack',
  },
});
