import { FederatedI18nBoundary, useModernI18n } from '@modern-js/plugin-i18n/runtime/consumer';
import type { JSX } from 'react';

import csResource from '../locales/cs/merchandise.json';
import enResource from '../locales/en/merchandise.json';

const federatedI18nLanguages = ['en', 'cs'];
const federatedI18nResources = {
  cs: { merchandise: csResource },
  en: { merchandise: enResource },
};

const MerchandiseRouteContent = () => {
  const { t } = useModernI18n();

  return (
    <section
      className="merchandise:rounded-2xl merchandise:bg-white/90 merchandise:p-5 merchandise:shadow-xl merchandise:shadow-stone-900/10"
      data-modern-boundary-id="verticalMerchandise"
      data-modern-mf-expose="./Route"
    >
      <h2 className="merchandise:text-2xl merchandise:font-black">{t('merchandise.title')}</h2>
      <p className="merchandise:mt-2 merchandise:text-stone-600">{t('merchandise.routeSurface')}</p>
    </section>
  );
};

const MerchandiseRoute = (props: Record<string, never>): JSX.Element => {
  void props;

  return (
    <FederatedI18nBoundary
      defaultNamespace="merchandise"
      fallbackLanguage="en"
      resources={federatedI18nResources}
      supportedLanguages={federatedI18nLanguages}
    >
      <MerchandiseRouteContent />
    </FederatedI18nBoundary>
  );
};

export default MerchandiseRoute;
