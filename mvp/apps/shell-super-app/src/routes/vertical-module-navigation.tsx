import { I18nLink, useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { CORE_TENANT_MODULE_STATES } from '../verticals/module-discovery.ts';
import { installedVerticalRegistrations } from '../verticals/installed.registry.ts';
import { getShellNavigationItems } from '../verticals/route-model.ts';

const navigationItems = getShellNavigationItems({
  registrations: installedVerticalRegistrations,
  tenantModuleStates: CORE_TENANT_MODULE_STATES,
});

export const VerticalModuleNavigation = () => {
  const { i18nInstance } = useModernI18n();
  const t = i18nInstance['t'].bind(i18nInstance);

  return (
    <nav
      aria-label={t('shell.navigation.microverticals')}
      className="shell:flex shell:min-w-0 shell:flex-wrap shell:items-center shell:gap-2"
    >
      {navigationItems.map((item) => (
        <I18nLink
          className="shell:inline-flex shell:min-h-10 shell:items-center shell:justify-center shell:rounded-md shell:border shell:border-stone-900/15 shell:bg-white shell:px-3 shell:text-sm shell:font-extrabold shell:text-stone-950 shell:no-underline shell:shadow-sm shell:shadow-stone-900/5"
          data-folder-name={item.folderName}
          data-module-id={item.moduleId}
          data-module-state={item.state}
          data-rendered-from={item.renderedFrom}
          key={item.moduleId}
          to={item.path}
        >
          {item.navigationLabel}
        </I18nLink>
      ))}
    </nav>
  );
};
