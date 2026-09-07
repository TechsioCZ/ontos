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
        className="partyregistry:mx-auto partyregistry:w-full partyregistry:max-w-5xl partyregistry:px-4 partyregistry:py-8 partyregistry:sm:px-8 partyregistry:lg:px-12"
      >
        <div className="partyregistry:grid partyregistry:gap-4">
          <h1
            className="partyregistry:text-3xl partyregistry:font-bold partyregistry:text-(--color-page-fg) partyregistry:sm:text-4xl"
            id={headingId}
          >
            {t('party-registry.pages.contacts.title')}
          </h1>
          <p className="partyregistry:max-w-2xl partyregistry:text-(--color-page-muted-fg)">
            {t('party-registry.pages.contacts.description')}
          </p>
        </div>
      </section>
    </>
  );
};

export default ContactsPage;
