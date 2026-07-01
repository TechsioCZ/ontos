import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Helmet } from '@modern-js/runtime/head';
import { ultramodernRouteMetadata } from './ultramodern-route-metadata';

const fallbackLanguage = 'en';
const route = ultramodernRouteMetadata[0];

export const UltramodernRouteHead = () => {
  const { i18nInstance } = useModernI18n();
  const t = i18nInstance['t'].bind(i18nInstance);
  const title = t(route.titleKey);
  const description = t(route.descriptionKey);

  return (
    <Helmet htmlAttributes={{ lang: i18nInstance.language ?? fallbackLanguage }}>
      <title>{title}</title>
      <meta content={description} name="description" />
      <meta content="noindex, nofollow" name="robots" />
    </Helmet>
  );
};
