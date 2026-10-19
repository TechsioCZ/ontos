import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Helmet } from '@modern-js/runtime/head';

export const UltramodernRouteHead = ({ titleKey = 'siampark-ops.title' }: { readonly titleKey?: string }) => {
  const { language, t } = useModernI18n();
  return (
    <Helmet htmlAttributes={{ lang: language ?? 'en' }}>
      <title>{t(titleKey)}</title>
      <meta content="noindex, nofollow" name="robots" />
    </Helmet>
  );
};
