import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Helmet } from '@modern-js/runtime/head';
import type { ReactElement } from 'react';

export interface UltramodernRouteHeadProps {
  /** Locale key of the page title, e.g. `party-registry.pages.customers.title`. */
  readonly titleKey: string;
}

/** Sets the document title from the page's own locale key, so the browser tab reads in Czech. */
export const UltramodernRouteHead = ({ titleKey }: UltramodernRouteHeadProps): ReactElement => {
  const { language, t } = useModernI18n();
  return (
    <Helmet htmlAttributes={{ lang: language ?? 'cs' }}>
      <title>{t(titleKey)}</title>
      <meta content="noindex, nofollow" name="robots" />
    </Helmet>
  );
};
