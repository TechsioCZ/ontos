import { assertI18nInstance } from '@modern-js/plugin-i18n/i18n';
import { defineRuntimeConfig } from '@modern-js/runtime';
import { createInstance } from 'i18next';
import csResource from '../locales/cs/contacts.json';
import enResource from '../locales/en/contacts.json';
import { ultramodernRouteNamespace } from './routes/ultramodern-route-metadata';

type LocaleResource = string | { readonly [key: string]: LocaleResource };

const isLocaleText = (resource: LocaleResource): resource is string =>
  resource === String(resource);

const flattenLocaleResource = (resource: LocaleResource, prefix = ''): Record<string, string> => {
  if (isLocaleText(resource)) {
    return prefix.length > 0 ? { [prefix]: resource } : {};
  }

  return Object.fromEntries(
    Object.entries(resource).flatMap(([key, value]) => {
      const nextKey = prefix.length > 0 ? `${prefix}.${key}` : key;
      return isLocaleText(value)
        ? [[nextKey, value]]
        : Object.entries(flattenLocaleResource(value, nextKey));
    }),
  );
};

const i18nInstance = createInstance();
assertI18nInstance(i18nInstance);

const resources = {
  cs: { [ultramodernRouteNamespace]: flattenLocaleResource(csResource) },
  en: { [ultramodernRouteNamespace]: flattenLocaleResource(enResource) },
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
