import { FederatedI18nBoundary } from '@modern-js/plugin-i18n/runtime';
import type { Resources } from '@modern-js/plugin-i18n/runtime';
import type { ReactNode } from 'react';
import csResource from '../../locales/cs/crm.json';
import enResource from '../../locales/en/crm.json';
import { ultramodernRouteNamespace } from '../routes/ultramodern-route-metadata';

type LocaleResource = string | { readonly [key: string]: LocaleResource };

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

const resources = {
  cs: { [ultramodernRouteNamespace]: flattenLocaleResource(csResource) },
  en: { [ultramodernRouteNamespace]: flattenLocaleResource(enResource) },
} satisfies Resources;

export const CrmFederatedI18nBoundary = ({ children }: { readonly children: ReactNode }) => (
  <FederatedI18nBoundary
    defaultNamespace={ultramodernRouteNamespace}
    fallbackLanguage="en"
    resources={resources}
    supportedLanguages={['en', 'cs']}
  >
    {children}
  </FederatedI18nBoundary>
);
