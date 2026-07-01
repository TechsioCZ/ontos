import { Link, useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { isModuleStateAccessAllowed } from '@mvp2/shared-contracts';
import type { InstalledModuleKey, ModuleActivationState } from '@mvp2/shared-contracts';
import { shellInstalledModules } from '../modules/installed-modules';
import { RemoteSlot } from './remote-slot';
import { useShellAuth } from './shell-auth-context';

const useVisibleModules = () => {
  const { context } = useShellAuth();
  const stateByModule =
    context === null
      ? new Map<InstalledModuleKey, ModuleActivationState>()
      : new Map<InstalledModuleKey, ModuleActivationState>(
          context.moduleStates.map((moduleState) => [moduleState.moduleKey, moduleState.state]),
        );

  return shellInstalledModules.filter((module) => {
    const state = stateByModule.get(module.moduleKey) ?? 'inactive';

    return isModuleStateAccessAllowed({ accessKind: 'load', state });
  });
};

const useModuleActivationState = (moduleKey: InstalledModuleKey) => {
  const { context } = useShellAuth();

  return (
    context?.moduleStates.find((moduleState) => moduleState.moduleKey === moduleKey)?.state ??
    'inactive'
  );
};

export const VisibleModuleCount = () => {
  const visibleModules = useVisibleModules();

  return <>{visibleModules.length}</>;
};

export const Header = () => {
  const { i18nInstance } = useModernI18n();
  const t = i18nInstance['t'].bind(i18nInstance);

  return (
    <header
      className="shell:flex shell:min-w-0 shell:flex-wrap shell:items-center shell:gap-x-8 shell:gap-y-2 shell:md:flex-1"
      data-modern-boundary-id="shellSuperApp"
      data-modern-mf-expose="shell/Header"
    >
      <Link
        className="shell:whitespace-nowrap shell:text-xl shell:font-black shell:tracking-normal shell:text-stone-950 shell:no-underline"
        to="/"
      >
        {t('shell.title')}
      </Link>
    </header>
  );
};

export const StatusBadge = () => {
  const { i18nInstance } = useModernI18n();
  const t = i18nInstance['t'].bind(i18nInstance);
  const visibleModules = useVisibleModules();

  return (
    <span className="shell:inline-flex shell:h-10 shell:shrink-0 shell:items-center shell:justify-center shell:rounded-full shell:border shell:border-stone-900/15 shell:bg-white shell:px-4 shell:text-sm shell:font-extrabold shell:text-stone-950 shell:shadow-lg shell:shadow-stone-900/5">
      {visibleModules.length} {t('shell.hero.cardOneKicker')}
    </span>
  );
};

export const VerticalShowcase = () => {
  const { i18nInstance } = useModernI18n();
  const t = i18nInstance['t'].bind(i18nInstance);
  const visibleModules = useVisibleModules();

  if (visibleModules.length === 0) {
    return (
      <section className="shell:mx-auto shell:mt-12 shell:max-w-7xl shell:rounded-2xl shell:bg-white/90 shell:p-6 shell:shadow-xl shell:shadow-stone-900/10">
        <p className="shell:text-lg shell:font-bold shell:text-stone-700">
          {t('shell.hero.empty')}
        </p>
      </section>
    );
  }

  return (
    <section
      className="shell:mx-auto shell:mt-12 shell:max-w-7xl"
      data-modern-boundary-id="shellSuperApp"
    >
      <div className="shell:grid shell:gap-4 shell:md:grid-cols-2">
        {visibleModules.map((module) => (
          <div className="shell:grid shell:gap-3" key={module.moduleKey}>
            <RemoteSlot specifier={module.widgetRemote} />
            {module.routePath === undefined ? null : (
              <Link
                className="shell:inline-flex shell:w-fit shell:rounded-full shell:border shell:border-stone-900/15 shell:bg-white shell:px-4 shell:py-2 shell:text-sm shell:font-bold shell:text-stone-950 shell:no-underline"
                to={module.routePath}
              >
                {t('shell.routes.viewModule', { module: module.label })}
              </Link>
            )}
          </div>
        ))}
      </div>
    </section>
  );
};

export const PropertiesRouteSurface = () => {
  const { i18nInstance } = useModernI18n();
  const t = i18nInstance['t'].bind(i18nInstance);
  const routeModule = shellInstalledModules.find((module) => module.moduleKey === 'properties');
  const state = useModuleActivationState('properties');

  if (
    routeModule?.routeRemote === undefined ||
    !isModuleStateAccessAllowed({ accessKind: 'load', state })
  ) {
    return (
      <section className="shell:mx-auto shell:mt-12 shell:max-w-7xl shell:bg-white/90 shell:p-6 shell:shadow-xl shell:shadow-stone-900/10">
        <p className="shell:text-lg shell:font-bold shell:text-stone-700">
          {t('shell.remotes.propertiesUnavailable')}
        </p>
      </section>
    );
  }

  return (
    <section
      className="shell:mx-auto shell:mt-12 shell:max-w-7xl"
      data-modern-boundary-id="shellSuperApp"
      data-ontos-module-id="properties"
    >
      <RemoteSlot specifier={routeModule.routeRemote} />
    </section>
  );
};
