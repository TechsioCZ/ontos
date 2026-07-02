import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Helmet } from '@modern-js/runtime/head';

const sanitiseJsonLd = (value: unknown) => JSON.stringify(value).replaceAll('<', '\\u003c');

export const UltramodernRouteHead = () => {
  const { t } = useModernI18n();
  const title = t('shell.title');
  const description = t('shell.seo.description');
  const canonicalUrl = '/';
  const route = { jsonLd: { '@type': 'WebSite', name: title } };
  const jsonLd = route?.jsonLd;

  return (
    <Helmet>
      <title>{title}</title>
      <meta content={description} name="description" />
      <meta content="noindex, nofollow" name="robots" />
      <link href={canonicalUrl} rel="canonical" />
      <link href="/" hrefLang="en" rel="alternate" />
      <link href="/" hrefLang="cs" rel="alternate" />
      <link href="/" hrefLang="x-default" rel="alternate" />
      <meta content={title} property="og:title" />
      <meta content={description} property="og:description" />
      <meta content={canonicalUrl} property="og:url" />
      <meta content="website" property="og:type" />
      <meta content="summary_large_image" name="twitter:card" />
      <meta content={title} name="twitter:title" />
      <meta content={description} name="twitter:description" />
      <script type="application/ld+json">{sanitiseJsonLd(jsonLd)}</script>
    </Helmet>
  );
};
