import type { Resources } from '@modern-js/plugin-i18n/runtime';
import type csResource from '../../locales/cs/crm.json';
import { ultramodernRouteNamespace } from '../routes/ultramodern-route-metadata';

type LocaleResource = string | { readonly [key: string]: LocaleResource };
type CrmLocaleResource = typeof csResource;

const flattenLocaleResource = (resource: LocaleResource, prefix = ''): Record<string, string> => {
  if (typeof resource === 'string') {
    return prefix.length > 0 ? { [prefix]: resource } : {};
  }

  return Object.fromEntries(
    Object.entries(resource).flatMap(([key, value]) => {
      const nextKey = prefix.length > 0 ? `${prefix}.${key}` : key;
      return typeof value === 'string'
        ? [[nextKey, value]]
        : Object.entries(flattenLocaleResource(value, nextKey));
    }),
  );
};

export const createCrmI18nResources = (
  resources: Record<'cs' | 'en', CrmLocaleResource>,
): Resources => ({
  cs: { [ultramodernRouteNamespace]: flattenLocaleResource(resources.cs) },
  en: { [ultramodernRouteNamespace]: flattenLocaleResource(resources.en) },
});

export const crmSupportedLanguages = ['en', 'cs'];
