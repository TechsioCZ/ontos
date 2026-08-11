import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { UltramodernRouteHead } from '../../ultramodern-route-head';

export const DealsPage = () => {
  const { t } = useModernI18n();
  const headingId = 'deals-heading';

  return (
    <>
      <UltramodernRouteHead />
      <main className="crm:min-h-screen crm:bg-(--color-page-bg) crm:px-4 crm:py-8 crm:text-(--color-page-fg) crm:sm:px-8 crm:lg:px-12">
        <div className="crm:mx-auto crm:flex crm:max-w-5xl crm:flex-col crm:gap-8">
          <header className="crm:space-y-3">
            <h1 className="crm:text-3xl crm:font-bold crm:sm:text-4xl" id={headingId}>
              {t('crm.pages.deals.title')}
            </h1>
            <p className="crm:max-w-2xl crm:text-base crm:sm:text-lg">
              {t('crm.pages.deals.description')}
            </p>
          </header>
          <section
            aria-labelledby={headingId}
            className="crm:bg-(--color-surface) crm:p-6 crm:sm:p-8"
          >
            <p>{t('crm.pages.deals.empty')}</p>
          </section>
        </div>
      </main>
    </>
  );
};

export default DealsPage;
