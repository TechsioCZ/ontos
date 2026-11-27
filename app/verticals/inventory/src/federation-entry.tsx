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
      className="rounded-lg bg-surface p-250 shadow-xl"
      data-modern-boundary-id="verticalInventory"
      data-modern-mf-expose="./Route"
    >
      <h2 className="text-2xl font-bold">{t('inventory.title')}</h2>
      <p className="mt-150 text-fg-secondary">{t('inventory.routeSurface')}</p>
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
