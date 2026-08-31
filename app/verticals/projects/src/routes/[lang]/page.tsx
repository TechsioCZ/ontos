import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Link } from '@modern-js/plugin-tanstack/runtime';
import { ultramodernUiMarker } from '../../ultramodern-build';
import { UltramodernRouteHead } from '../ultramodern-route-head';

const ProjectsHome = () => {
  const { language, supportedLanguages, t } = useModernI18n();

  return (
    <main className="projects:min-h-screen projects:bg-um-canvas projects:px-4 projects:py-6 projects:text-um-foreground projects:sm:px-8">
      <UltramodernRouteHead />
      <nav aria-label={t('projects.language.switcher')} className="projects:flex projects:gap-3">
        {supportedLanguages.map((code) => (
          <Link
            aria-current={language === code ? 'page' : undefined}
            className="projects:rounded-full projects:border projects:border-stone-900/15 projects:bg-white projects:px-4 projects:py-2 projects:text-sm projects:font-bold projects:text-stone-950 projects:no-underline"
            key={code}
            params={{ lang: code }}
            to="/$lang"
          >
            {t(`projects.language.${code}`)}
          </Link>
        ))}
      </nav>
      <h1 className="projects:mt-10 projects:text-5xl projects:font-black">
        {t('projects.title')}
      </h1>
      <p
        className="projects:mt-3 projects:text-lg projects:text-stone-600"
        data-modern-mf-role="vertical"
      >
        {t('projects.role')}
      </p>
      <p
        className="projects:sr-only"
        data-build-marker={ultramodernUiMarker.build}
        data-testid="ultramodern-ui-marker"
      >
        {ultramodernUiMarker.appId}:{ultramodernUiMarker.version}
      </p>
    </main>
  );
};

export default ProjectsHome;
