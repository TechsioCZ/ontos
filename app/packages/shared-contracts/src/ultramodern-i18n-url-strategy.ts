/**
 * Shared adapter from a generated localised-URL map to the `I18nUrlStrategy`
 * contract that `@modern-js/plugin-i18n` consumes.
 *
 * Every generated `src/routes/ultramodern-route-metadata.ts` owns its own URL
 * map, but the translation between that map and the framework contract is the
 * same for every app, so it lives here instead of being repeated per app.
 */
export type UltramodernLocalisedUrls = Readonly<Record<string, Readonly<Record<string, string>>>>;

export interface UltramodernI18nUrlStrategy {
  readonly canonicalPathname: (pathname: string, languages: readonly string[]) => string;
  readonly localizePathname: (pathname: string, language: string, languages: readonly string[]) => string;
}

export const createUltramodernI18nUrlStrategy = (
  localisedUrls: UltramodernLocalisedUrls,
): UltramodernI18nUrlStrategy => ({
  canonicalPathname: (pathname: string, languages: readonly string[]): string => {
    const knownLanguages = new Set(languages);
    for (const [canonicalPath, localisedPaths] of Object.entries(localisedUrls)) {
      for (const [language, localisedPath] of Object.entries(localisedPaths)) {
        if (localisedPath === pathname && knownLanguages.has(language)) {
          return canonicalPath;
        }
      }
    }
    return pathname;
  },
  localizePathname: (pathname: string, language: string, _languages: readonly string[]): string => {
    for (const [canonicalPath, localisedPaths] of Object.entries(localisedUrls)) {
      if (canonicalPath !== pathname) {
        continue;
      }
      for (const [candidate, localisedPath] of Object.entries(localisedPaths)) {
        if (candidate === language) {
          return localisedPath;
        }
      }
    }
    return pathname;
  },
});
