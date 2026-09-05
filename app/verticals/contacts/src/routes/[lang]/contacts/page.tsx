import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { UltramodernRouteHead } from '../../ultramodern-route-head';

export const ContactsPage = () => {
  const { t } = useModernI18n();
  const headingId = 'contacts-heading';

  return (
    <>
      <UltramodernRouteHead />
      <section
        aria-labelledby={headingId}
        className="contacts:mx-auto contacts:w-full contacts:max-w-5xl contacts:px-4 contacts:py-8 contacts:sm:px-8 contacts:lg:px-12"
      >
        <div className="contacts:grid contacts:gap-4">
          <h1
            className="contacts:text-3xl contacts:font-bold contacts:text-(--color-page-fg) contacts:sm:text-4xl"
            id={headingId}
          >
            {t('contacts.pages.contacts.title')}
          </h1>
          <p className="contacts:max-w-2xl contacts:text-(--color-page-muted-fg)">
            {t('contacts.pages.contacts.description')}
          </p>
        </div>
      </section>
    </>
  );
};

export default ContactsPage;
