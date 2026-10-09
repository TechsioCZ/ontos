import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Helmet } from '@modern-js/runtime/head';

/** Catalog is an authenticated application surface; it must never be indexed. */
export const UltramodernRouteHead = () => {
  const { language, t } = useModernI18n();

  return (
    <Helmet htmlAttributes={{ lang: language ?? 'en' }}>
      <title>{t('catalog.title')}</title>
      <meta content={t('catalog.seo.description')} name="description" />
      <meta content="noindex, nofollow" name="robots" />
    </Helmet>
  );
};
