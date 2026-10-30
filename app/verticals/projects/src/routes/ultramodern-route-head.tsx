import { Helmet } from '@modern-js/runtime/head';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime/consumer';

export const UltramodernRouteHead = () => {
  const { t } = useModernI18n();
  return (
    <Helmet>
      <title>{t('projects.pages.createProject.title')}</title>
      <meta content={t('projects.pages.createProject.description')} name="description" />
      <meta content="noindex, nofollow" name="robots" />
    </Helmet>
  );
};
