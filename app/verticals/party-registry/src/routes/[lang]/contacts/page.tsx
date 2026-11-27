import { FederatedI18nBoundary, useModernI18n } from '@modern-js/plugin-i18n/runtime/consumer';

import { partyRegistryI18nResources } from '../../../i18n/resources.ts';
import { UltramodernRouteHead } from '../../ultramodern-route-head';

const ContactsContent = () => {
  const { t } = useModernI18n();
  const headingId = 'contacts-heading';

  return (
    <>
      <UltramodernRouteHead />
      <section aria-labelledby={headingId} className="mx-auto w-full max-w-5xl px-200 py-400 sm:px-400 lg:px-550">
        <div className="grid gap-200">
          <h1 className="text-3xl font-bold text-fg-primary sm:text-4xl" id={headingId}>
            {t('party-registry.pages.contacts.title')}
          </h1>
          <p className="max-w-2xl text-fg-secondary">{t('party-registry.pages.contacts.description')}</p>
        </div>
      </section>
    </>
  );
};

const ContactsPage = () => (
  <FederatedI18nBoundary
    defaultNamespace="party-registry"
    fallbackLanguage="en"
    resources={partyRegistryI18nResources}
    supportedLanguages={['en', 'cs']}
  >
    <ContactsContent />
  </FederatedI18nBoundary>
);

export default ContactsPage;
