import { useLocalizedLocation, useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Helmet } from '@modern-js/runtime/head';
import { ultramodernRouteMetadata } from './ultramodern-route-metadata';

const appName = 'Shell Super App';
const fallbackLanguage = 'en';
const supportedLanguages = ['en', 'cs'] as const;
type SupportedLanguage = (typeof supportedLanguages)[number];
type GeneratedRouteMetadata = (typeof ultramodernRouteMetadata)[number];
type RouteMetadata = Omit<GeneratedRouteMetadata, 'indexable' | 'public'> & {
  readonly indexable?: boolean;
  readonly public?: boolean;
};

const routeMetadata = ultramodernRouteMetadata as readonly RouteMetadata[];

const isSupportedLanguage = (value: string): value is SupportedLanguage =>
  supportedLanguages.includes(value as SupportedLanguage);

const normalisePath = (pathname: string) => {
  const normalised = pathname.replaceAll(/\/+/gu, '/').replace(/\/+$/u, '');
  return normalised.length > 0 ? normalised : '/';
};

const stripLanguagePrefix = (pathname: string) => {
  const segments = normalisePath(pathname).split('/').filter(Boolean);
  if (segments.length > 0 && isSupportedLanguage(segments[0] ?? '')) {
    segments.shift();
  }
  return `/${segments.join('/')}`;
};

const escapeRegExp = (value: string) => value.replaceAll(/[.*+?^${}()|[\]\\]/gu, '\\$&');

const matchPattern = (pathname: string, pattern: string) => {
  const source = normalisePath(pattern)
    .split('/')
    .filter(Boolean)
    .map((segment) => {
      if (segment.startsWith(':')) {
        return segment.endsWith('?') ? '(?:/([^/]+))?' : '/([^/]+)';
      }
      return `/${escapeRegExp(segment)}`;
    })
    .join('');
  return new RegExp(`^${source || '/'}$`, 'u').test(normalisePath(pathname));
};

const resolveRouteMetadata = (pathname: string) => {
  const pathWithoutLanguage = stripLanguagePrefix(pathname);

  for (const route of routeMetadata) {
    if (matchPattern(pathWithoutLanguage, route.canonicalPath)) {
      return route;
    }

    for (const language of supportedLanguages) {
      if (matchPattern(pathWithoutLanguage, route.localisedPaths[language])) {
        return route;
      }
    }
  }

  return routeMetadata[0];
};

const absoluteUrl = (pathname: string) => {
  const origin = ULTRAMODERN_SITE_URL.replace(/\/+$/u, '');
  return `${origin}${pathname}`;
};

export const UltramodernRouteHead = () => {
  const { i18nInstance } = useModernI18n();
  const t = i18nInstance['t'].bind(i18nInstance);
  const { canonical, alternates } = useLocalizedLocation();
  const route = resolveRouteMetadata(canonical);
  const title = route === undefined ? appName : t(route.titleKey);
  const description = route === undefined ? appName : t(route.descriptionKey);
  const canonicalUrl = absoluteUrl(alternates[fallbackLanguage] ?? `/${fallbackLanguage}`);
  const indexable = route === undefined ? false : route.public === true && route.indexable === true;

  return (
    <Helmet htmlAttributes={{ lang: i18nInstance.language ?? fallbackLanguage }}>
      <title>{title}</title>
      <meta content={description} name="description" />
      <meta content={indexable ? 'index, follow' : 'noindex, nofollow'} name="robots" />
      {indexable && (
        <>
          <link rel="canonical" href={canonicalUrl} />
          {supportedLanguages.map((code) => (
            <link
              href={absoluteUrl(alternates[code] ?? `/${code}`)}
              hrefLang={code}
              key={code}
              rel="alternate"
            />
          ))}
          <link
            href={absoluteUrl(alternates[fallbackLanguage] ?? `/${fallbackLanguage}`)}
            hrefLang="x-default"
            rel="alternate"
          />
          <meta content={title} property="og:title" />
          <meta content={description} property="og:description" />
          <meta content={canonicalUrl} property="og:url" />
          <meta content="website" property="og:type" />
          <meta content={i18nInstance.language ?? fallbackLanguage} property="og:locale" />
          <meta content="summary_large_image" name="twitter:card" />
          <meta content={title} name="twitter:title" />
          <meta content={description} name="twitter:description" />
        </>
      )}
    </Helmet>
  );
};
