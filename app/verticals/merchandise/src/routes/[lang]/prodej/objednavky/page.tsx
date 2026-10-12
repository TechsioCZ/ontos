import { FederatedI18nBoundary, useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { UltramodernRouteHead } from '../../../ultramodern-route-head';
import csResource from '../../../../../locales/cs/merchandise.json';
import enResource from '../../../../../locales/en/merchandise.json';
import '../../../index.css';

const merchandiseI18nResources = {
  cs: { merchandise: csResource },
  en: { merchandise: enResource },
} as const;

const OrdersPageContent = () => {
  const { t } = useModernI18n();
  const headingId = 'orders-heading';

  return (
    <>
      <UltramodernRouteHead />
      <section
        aria-labelledby={headingId}
        className="merchandise:mx-auto merchandise:w-full merchandise:max-w-5xl merchandise:px-4 merchandise:py-8 merchandise:sm:px-8 merchandise:lg:px-12"
      >
        <h1
          className="merchandise:text-3xl merchandise:font-bold merchandise:text-(--color-page-fg) merchandise:sm:text-4xl"
          id={headingId}
        >
          {t('merchandise.pages.orders.title')}
        </h1>
      </section>
    </>
  );
};

export const OrdersPage = () => (
  <FederatedI18nBoundary
    defaultNamespace="merchandise"
    fallbackLanguage="en"
    resources={merchandiseI18nResources}
    supportedLanguages={['en', 'cs']}
  >
    <OrdersPageContent />
  </FederatedI18nBoundary>
);

export default OrdersPage;
