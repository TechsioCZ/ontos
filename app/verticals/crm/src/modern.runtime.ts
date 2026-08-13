import { defineRuntimeConfig } from '@modern-js/runtime';
import csResource from '../locales/cs/crm.json';
import enResource from '../locales/en/crm.json';
import {
  createCrmI18nResources,
  crmFallbackLanguage,
  crmSupportedLanguages,
} from './i18n/crm-i18n-resources';
import { ultramodernRouteNamespace } from './routes/ultramodern-route-metadata';

const resources = createCrmI18nResources({ cs: csResource, en: enResource });

export default defineRuntimeConfig({
  i18n: {
    initOptions: {
      defaultNS: ultramodernRouteNamespace,
      fallbackLng: crmFallbackLanguage,
      interpolation: {
        escapeValue: false,
      },
      ns: [ultramodernRouteNamespace, 'translation'],
      resources,
      supportedLngs: crmSupportedLanguages,
    },
  },

  router: {
    framework: 'tanstack',
  },
});
