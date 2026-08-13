import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { UltramodernRouteHead } from '../../ultramodern-route-head';

export const CrmPage = () => {
  const { t } = useModernI18n();
  const headingId = 'crm-heading';

  return (
    <>
      <UltramodernRouteHead />
      <section
        aria-labelledby={headingId}
        className="crm:mx-auto crm:w-full crm:max-w-5xl crm:px-4 crm:py-8 crm:sm:px-8 crm:lg:px-12"
      >
        <h1
          className="crm:text-3xl crm:font-bold crm:text-(--color-page-fg) crm:sm:text-4xl"
          id={headingId}
        >
          {t('crm.pages.crm.title')}
        </h1>
      </section>
    </>
  );
};

export default CrmPage;
