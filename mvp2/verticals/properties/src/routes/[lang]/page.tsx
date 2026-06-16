import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Link } from '@modern-js/plugin-tanstack/runtime';
import { CreateUnitButton } from '../../components/create-unit-button';
import { UltramodernRouteHead } from '../ultramodern-route-head';
import { ultramodernUiMarker } from '../../ultramodern-build';

export default function PropertiesHome() {
  const { i18nInstance, language, supportedLanguages } = useModernI18n();
  const t = i18nInstance['t'].bind(i18nInstance);

  return (
    <main className="properties:min-h-screen properties:bg-um-canvas properties:px-4 properties:py-6 properties:text-um-foreground properties:sm:px-8">
      <UltramodernRouteHead />
      <nav
        aria-label={t('properties.language.switcher')}
        className="properties:flex properties:gap-3"
      >
        {supportedLanguages.map((code) => (
          <Link
            aria-current={language === code ? 'page' : undefined}
            className="properties:rounded-full properties:border properties:border-stone-900/15 properties:bg-white properties:px-4 properties:py-2 properties:text-sm properties:font-bold properties:text-stone-950 properties:no-underline"
            key={code}
            params={{ lang: code }}
            to="/$lang"
          >
            {t(`properties.language.${code}`)}
          </Link>
        ))}
      </nav>
      <h1 className="properties:mt-10 properties:text-5xl properties:font-black">
        {t('properties.title')}
      </h1>
      <p
        className="properties:mt-3 properties:text-lg properties:text-stone-600"
        data-modern-mf-role="vertical"
      >
        {t('properties.role')}
      </p>
      <p
        className="properties:sr-only"
        data-build-marker={ultramodernUiMarker.build}
        data-testid="ultramodern-ui-marker"
      >
        {ultramodernUiMarker.appId}:{ultramodernUiMarker.version}
      </p>
      <div className="properties:mt-6">
        <CreateUnitButton />
      </div>
    </main>
  );
}
