import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Helmet } from '@modern-js/runtime/head';

export const UltramodernRouteHead = () => {
  const { language, t } = useModernI18n();
  return (
    <Helmet htmlAttributes={{ lang: language ?? 'en' }}>
      <title>{t('crm.title')}</title>
      <meta content="noindex, nofollow" name="robots" />
    </Helmet>
  );
};
