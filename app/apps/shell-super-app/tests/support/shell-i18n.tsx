import { assertI18nInstance } from '@modern-js/plugin-i18n/i18n';
import type { I18nUrlStrategy } from '@modern-js/plugin-i18n/runtime';
import { ModernI18nProvider } from '@modern-js/plugin-i18n/runtime/consumer';
import { Option } from 'effect';
import { createInstance } from 'i18next';
import type { i18n } from 'i18next';
import type { ReactNode } from 'react';

import cs from '../../locales/cs/shell.json';
import en from '../../locales/en/shell.json';
import { ultramodernLocalisedUrls } from '../../src/routes/ultramodern-route-metadata.ts';

export const shellLanguages = ['en', 'cs'] as const;
export type ShellLanguage = (typeof shellLanguages)[number];

const routePatterns = Object.entries(ultramodernLocalisedUrls).map(([canonical, localised]) => ({
  canonical: canonical.split('/').filter(Boolean),
  localised: { cs: localised.cs.split('/').filter(Boolean), en: localised.en.split('/').filter(Boolean) },
}));

/** Matches concrete segments against a route pattern, returning the values its `:parameters` hold. */
const matchSegments = (pattern: readonly string[], segments: readonly string[]) => {
  if (pattern.length !== segments.length) {
    return Option.none<ReadonlyMap<string, string>>();
  }
  const values = new Map<string, string>();
  for (const [index, part] of pattern.entries()) {
    const segment = segments[index] ?? '';
    if (part.startsWith(':')) {
      values.set(part, segment);
    } else if (part !== segment) {
      return Option.none<ReadonlyMap<string, string>>();
    }
  }
  return Option.some<ReadonlyMap<string, string>>(values);
};

const fill = (pattern: readonly string[], values: ReadonlyMap<string, string>) =>
  pattern.map((part) => values.get(part) ?? part);

const withoutLanguage = (pathname: string, languages: readonly string[]) => {
  const segments = pathname.split('/').filter(Boolean);
  return languages.includes(segments[0] ?? '') ? segments.slice(1) : segments;
};

/**
 * The Shell's localised URL policy over its own generated route map, as the i18n integration builds
 * it in production: a canonical path gets the language prefix and that language's localised path.
 */
export const shellUrlStrategy: I18nUrlStrategy = {
  canonicalPathname: (pathname, languages) => {
    const segments = withoutLanguage(pathname, languages);
    for (const route of routePatterns) {
      for (const localised of Object.values(route.localised)) {
        const values = matchSegments(localised, segments);
        if (Option.isSome(values)) {
          return `/${fill(route.canonical, values.value).join('/')}`;
        }
      }
    }
    return `/${segments.join('/')}`;
  },
  localizePathname: (pathname, language, languages) => {
    const segments = withoutLanguage(pathname, languages);
    for (const route of routePatterns) {
      const values = matchSegments(route.canonical, segments);
      const localised = language === 'cs' ? route.localised.cs : route.localised.en;
      if (Option.isSome(values)) {
        return `/${[language, ...fill(localised, values.value)].join('/')}`;
      }
    }
    return `/${[language, ...segments].join('/')}`;
  },
};

/** The i18next instance as the Modern.js i18n context holds it, admitted by the plugin's own instance check. */
const modernInstance = (instance: i18n) => {
  assertI18nInstance(instance);
  return instance;
};

/** Real i18next over copy the test owns, keyed flat; an absent key renders as the key itself. */
export const shellTestCopy = (language: ShellLanguage, copy: Readonly<Record<string, string>>): i18n => {
  const instance = createInstance();
  void instance.init({
    initAsync: false,
    interpolation: { escapeValue: false },
    keySeparator: false,
    lng: language,
    resources: { [language]: { translation: copy } },
  });
  return instance;
};

/** Real i18next over the Shell's own locale files. */
export const shellLocaleCopy = (language: ShellLanguage): i18n => {
  const instance = createInstance();
  void instance.init({
    initAsync: false,
    interpolation: { escapeValue: false },
    lng: language,
    resources: { cs: { translation: cs }, en: { translation: en } },
  });
  return instance;
};

/**
 * The Modern.js i18n context the Shell renders under, with the given translator. Pages read it
 * through the real `useModernI18n`, `Link` and `useLocalizedLocation`.
 */
export const ShellI18n = ({
  children,
  translations,
}: {
  readonly children: ReactNode;
  readonly translations: i18n;
}) => (
  <ModernI18nProvider
    value={{
      i18nInstance: modernInstance(translations),
      language: translations.language,
      languages: [...shellLanguages],
      urlStrategy: shellUrlStrategy,
    }}
  >
    {children}
  </ModernI18nProvider>
);
