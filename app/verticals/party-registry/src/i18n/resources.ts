import csResource from '../../locales/cs/party-registry.json' with { type: 'json' };
import enResource from '../../locales/en/party-registry.json' with { type: 'json' };
import { isString } from 'effect/Predicate';
import { ultramodernRouteNamespace } from '../routes/ultramodern-route-metadata.ts';

type LocaleResource = string | { readonly [key: string]: LocaleResource };

const isLocaleText = (resource: LocaleResource): resource is string => isString(resource);

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

export const partyRegistryI18nResources = {
  cs: { [ultramodernRouteNamespace]: flattenLocaleResource(csResource) },
  en: { [ultramodernRouteNamespace]: flattenLocaleResource(enResource) },
} as const;
