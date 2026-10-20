import { Link as LocalizedLink, useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { useLoaderData } from '@modern-js/plugin-tanstack/runtime';
import { Match } from 'effect';
import { LinkButton } from '@techsio/ui-kit/atoms/link-button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';

import { AuthenticatedDashboardLayout } from '../shell-frame';
import { UltramodernRouteHead } from '../ultramodern-route-head';
import { useShellControls } from '../use-shell-controls.ts';
import { ResolvedTarget } from './modules/[moduleId]/page.tsx';
import type { HomePageModel } from './home-page-model.ts';

interface HomeViewProps {
  readonly initialModel: HomePageModel;
}

export const HomeView = ({ initialModel }: HomeViewProps) => {
  const { t } = useModernI18n();
  const model = initialModel;
  const controls = useShellControls(model.state === 'authenticated' ? model : undefined);

  if (model.state === 'anonymous') {
    return (
      <>
        <UltramodernRouteHead />
        <main className="shell:flex shell:min-h-screen shell:items-center shell:justify-center shell:bg-(--color-page-bg) shell:p-4">
          <LinkButton as={LocalizedLink} size="md" theme="solid" to="/login" variant="primary">
            {t('shell.auth.loginLink')}
          </LinkButton>
        </main>
      </>
    );
  }

  if (model.state === 'unavailable' || model.state === 'reload_required' || controls.reloadRequired) {
    return (
      <>
        <UltramodernRouteHead />
        <main className="shell:flex shell:min-h-screen shell:items-center shell:justify-center shell:bg-(--color-page-bg) shell:p-4">
          <StatusText aria-live="polite" showIcon status="error">
            {t(
              model.state === 'reload_required' || controls.reloadRequired
                ? 'shell.moduleTarget.reload_required'
                : 'shell.dashboard.unavailable',
            )}
          </StatusText>
        </main>
      </>
    );
  }

  const companyName = model.legalEntities.items.find(
    ({ legalEntityId }) => legalEntityId === model.selectedLegalEntityId,
  )?.legalName;

  return (
    <>
      <UltramodernRouteHead />
      <AuthenticatedDashboardLayout
        {...(model.compositionRevision === undefined ? {} : { compositionRevision: model.compositionRevision })}
        {...(model.selectedLegalEntityId === undefined ? {} : { currentLegalEntityId: model.selectedLegalEntityId })}
        currentTenantId={model.identity.tenantId}
        identity={{ displayName: model.identity.displayName }}
        legalEntityChoices={model.legalEntities.items}
        legalEntityState={model.legalEntities.state}
        legalEntitySwitchFailed={controls.legalEntitySwitchFailed}
        legalEntitySwitchPending={controls.legalEntitySwitchPending}
        logoutPending={controls.logoutPending}
        navigation={model.navigation.items}
        onLegalEntityChange={controls.handleLegalEntityChange}
        onLogout={controls.handleLogout}
        onSearch={controls.handleSearch}
        onTenantChange={controls.handleTenantChange}
        tenantChoices={model.tenants.items}
        tenantState={model.tenants.state}
        tenantSwitchFailed={controls.tenantSwitchFailed}
        tenantSwitchPending={controls.tenantSwitchPending}
        title={t('shell.dashboard.home.title')}
        unavailableDeployments={model.navigation.unavailableDeployments}
      >
        <section className="shell:flex shell:w-full shell:flex-col shell:gap-4">
          {Match.value(model.homeContribution).pipe(
            Match.when({ state: 'ready' }, (contribution) => (
              <ResolvedTarget
                key={`${model.identity.principalId}:${model.identity.tenantId}:${model.selectedLegalEntityId}`}
                model={{ routeParams: {}, shell: model, state: 'resolved', target: contribution.target }}
              />
            )),
            // Roles without the sales dashboard (CRM and e-shop companies) get a welcome card instead of a denial.
            Match.when({ state: 'forbidden' }, () => (
              <div className="flex max-w-2xl flex-col gap-200 rounded-lg border border-border-primary bg-base p-300">
                <span className="text-fg-secondary text-xs uppercase tracking-wide">
                  {t('shell.dashboard.home.welcomeKicker')}
                </span>
                <h2 className="font-semibold text-fg-primary text-xl">
                  {t('shell.dashboard.home.welcomeTitle', { name: model.identity.displayName })}
                </h2>
                {companyName === undefined ? null : (
                  <p className="text-fg-primary">
                    {t('shell.dashboard.home.welcomeCompany', { company: companyName })}
                  </p>
                )}
                <p className="text-fg-secondary text-sm">{t('shell.dashboard.home.welcomeHint')}</p>
              </div>
            )),
            Match.when({ state: 'unavailable' }, () => (
              <StatusText aria-live="polite" showIcon status="error">
                {t('shell.dashboard.unavailable')}
              </StatusText>
            )),
            Match.orElse(() => null),
          )}
          {model.contextState === 'selection_required' ? (
            <StatusText aria-live="polite" showIcon status="warning">
              {t('shell.dashboard.legalEntity.selectionRequired')}
            </StatusText>
          ) : null}
          {model.contextState === 'access_blocked' ? (
            <StatusText aria-live="polite" showIcon status="error">
              {t('shell.dashboard.legalEntity.accessBlocked')}
            </StatusText>
          ) : null}
          {model.navigation.state === 'unavailable' ? (
            <StatusText aria-live="polite" id="module-navigation-unavailable" showIcon status="error">
              {t('shell.modules.unavailable')}
            </StatusText>
          ) : null}
          {controls.logoutFailed ? (
            <StatusText aria-live="polite" showIcon status="error">
              {t('shell.auth.logout.failed')}
            </StatusText>
          ) : null}
        </section>
      </AuthenticatedDashboardLayout>
    </>
  );
};

const ShellHome = () => {
  const initialModel = useLoaderData({ from: '/$lang/' });
  return <HomeView initialModel={initialModel} />;
};

export default ShellHome;
