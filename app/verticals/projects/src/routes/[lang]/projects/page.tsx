import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Link as RouterLink } from '@modern-js/plugin-tanstack/runtime';
import { Link } from '@techsio/ui-kit/atoms/link';
import { UltramodernRouteHead } from '../../ultramodern-route-head';

export const ProjectsPage = () => {
  const { language, t } = useModernI18n();
  const headingId = 'projects-heading';

  return (
    <>
      <UltramodernRouteHead />
      <section
        aria-labelledby={headingId}
        className="projects:mx-auto projects:w-full projects:max-w-5xl projects:px-4 projects:py-8 projects:sm:px-8 projects:lg:px-12"
      >
        <div className="projects:grid projects:gap-4">
          <h1
            className="projects:text-3xl projects:font-bold projects:text-(--color-page-fg) projects:sm:text-4xl"
            id={headingId}
          >
            {t('projects.pages.projects.title')}
          </h1>
          <Link as={RouterLink} to={`/${language}/projects/customers`}>
            {t('projects.pages.projects.customers')}
          </Link>
        </div>
      </section>
    </>
  );
};

export default ProjectsPage;
