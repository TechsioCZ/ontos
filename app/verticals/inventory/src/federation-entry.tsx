import { FederatedI18nBoundary, useModernI18n } from '@modern-js/plugin-i18n/runtime/consumer';
import type { JSX } from 'react';

import csResource from '../locales/cs/inventory.json';
import enResource from '../locales/en/inventory.json';

const federatedI18nLanguages = ['en', 'cs'];
const federatedI18nResources = {
  cs: { inventory: csResource },
  en: { inventory: enResource },
};

const InventoryRouteContent = () => {
  const { t } = useModernI18n();

  return (
    <section
      className="inventory:rounded-2xl inventory:bg-white/90 inventory:p-5 inventory:shadow-xl inventory:shadow-stone-900/10"
      data-modern-boundary-id="verticalInventory"
      data-modern-mf-expose="./Route"
    >
      <h2 className="inventory:text-2xl inventory:font-black">{t('inventory.title')}</h2>
      <p className="inventory:mt-2 inventory:text-stone-600">{t('inventory.routeSurface')}</p>
    </section>
  );
};

const InventoryRoute = (props: Record<string, never>): JSX.Element => {
  void props;

  return (
    <FederatedI18nBoundary
      defaultNamespace="inventory"
      fallbackLanguage="en"
      resources={federatedI18nResources}
      supportedLanguages={federatedI18nLanguages}
    >
      <InventoryRouteContent />
    </FederatedI18nBoundary>
  );
};

export default InventoryRoute;
