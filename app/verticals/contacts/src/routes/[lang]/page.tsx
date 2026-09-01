import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Link } from '@modern-js/plugin-tanstack/runtime';
import { ultramodernUiMarker } from '../../ultramodern-build';
import { UltramodernRouteHead } from '../ultramodern-route-head';

const ContactsHome = () => {
  const { language, supportedLanguages, t } = useModernI18n();

  return (
    <main className="contacts:min-h-screen contacts:bg-um-canvas contacts:px-4 contacts:py-6 contacts:text-um-foreground contacts:sm:px-8">
      <UltramodernRouteHead />
      <nav aria-label={t('contacts.language.switcher')} className="contacts:flex contacts:gap-3">
        {supportedLanguages.map((code) => (
          <Link
            aria-current={language === code ? 'page' : undefined}
            className="contacts:rounded-full contacts:border contacts:border-stone-900/15 contacts:bg-white contacts:px-4 contacts:py-2 contacts:text-sm contacts:font-bold contacts:text-stone-950 contacts:no-underline"
            key={code}
            params={{ lang: code }}
            to="/$lang"
          >
            {t(`contacts.language.${code}`)}
          </Link>
        ))}
      </nav>
      <h1 className="contacts:mt-10 contacts:text-5xl contacts:font-black">
        {t('contacts.title')}
      </h1>
      <p
        className="contacts:mt-3 contacts:text-lg contacts:text-stone-600"
        data-modern-mf-role="vertical"
      >
        {t('contacts.role')}
      </p>
      <p
        className="contacts:sr-only"
        data-build-marker={ultramodernUiMarker.build}
        data-testid="ultramodern-ui-marker"
      >
        {ultramodernUiMarker.appId}:{ultramodernUiMarker.version}
      </p>
    </main>
  );
};

export default ContactsHome;
