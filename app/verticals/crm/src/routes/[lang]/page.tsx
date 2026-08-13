import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Link } from '@modern-js/plugin-tanstack/runtime';
import { ultramodernUiMarker } from '../../ultramodern-build';
import { UltramodernRouteHead } from '../ultramodern-route-head';

export default function CrmHome() {
  const { language, supportedLanguages, t } = useModernI18n();

  return (
    <main className="crm:min-h-screen crm:bg-um-canvas crm:px-4 crm:py-6 crm:text-um-foreground crm:sm:px-8">
      <UltramodernRouteHead />
      <nav aria-label={t('crm.language.switcher')} className="crm:flex crm:gap-3">
        {supportedLanguages.map((code) => (
          <Link
            aria-current={language === code ? 'page' : undefined}
            className="crm:rounded-full crm:border crm:border-stone-900/15 crm:bg-white crm:px-4 crm:py-2 crm:text-sm crm:font-bold crm:text-stone-950 crm:no-underline"
            key={code}
            params={{ lang: code }}
            to="/$lang"
          >
            {t(`crm.language.${code}`)}
          </Link>
        ))}
      </nav>
      <h1 className="crm:mt-10 crm:text-5xl crm:font-black">{t('crm.title')}</h1>
      <p className="crm:mt-3 crm:text-lg crm:text-stone-600" data-modern-mf-role="vertical">
        {t('crm.role')}
      </p>
      <p
        className="crm:sr-only"
        data-build-marker={ultramodernUiMarker.build}
        data-testid="ultramodern-ui-marker"
      >
        {ultramodernUiMarker.appId}:{ultramodernUiMarker.version}
      </p>
    </main>
  );
}
