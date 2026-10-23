import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { useLoaderData } from '@modern-js/plugin-tanstack/runtime';
import { Effect, Match } from 'effect';
import { useEffect, useState } from 'react';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';

import { DemoGuideHomeCard } from '../../demo-guide/demo-guide-home-card.tsx';
import { AuthenticatedDashboardLayout } from '../shell-frame';
import { UltramodernRouteHead } from '../ultramodern-route-head';
import { SignInRedirect } from '../sign-in-redirect.tsx';
import { useShellControls } from '../use-shell-controls.ts';
import { browserRuntime } from '../../runtime/browser-effect-runtime.ts';
import { shellAuthenticationClientOptionsFromRequest } from '../shell-authentication-client-options.ts';
import { HomeWelcome } from './home-welcome.tsx';
import { ModulePageSkeleton } from '../module-page-skeleton.tsx';
import { ResolvedTarget } from './modules/[moduleId]/page.tsx';
import { resolveHomeContributionWithWelcome } from './home-page-model.ts';
import type { HomePageModel, ResolvedHomeContribution } from './home-page-model.ts';

/** Home components take no route parameters; one frozen record keeps their props stable across renders. */
const homeRouteParams: Readonly<Record<string, string>> = Object.freeze({});

interface HomeViewProps {
  readonly initialModel: HomePageModel;
}

const deferredHomeKey = (model: HomePageModel) =>
  model.state === 'authenticated' && model.homeCandidates !== undefined && model.compositionRevision !== undefined
    ? [
        model.identity.principalId,
        model.identity.tenantId,
        model.selectedLegalEntityId,
        model.compositionRevision,
        ...model.homeCandidates.map(({ entrypointKey, moduleId }) => `${moduleId}/${entrypointKey}`),
      ].join('\u0000')
    : undefined;

/**
 * Server rendering leaves the Home component to the browser (it is a browser-loaded remote anyway), so the document
 * does not wait for its target resolution: after hydration the browser resolves the candidates the server chose.
 */
const useHomeContribution = (model: HomePageModel): ResolvedHomeContribution | undefined => {
  const key = deferredHomeKey(model);
  const [resolved, setResolved] = useState<{ readonly key: string; readonly value: ResolvedHomeContribution }>();
  useEffect(() => {
    const controller = new AbortController();
    if (
      key !== undefined &&
      model.state === 'authenticated' &&
      model.homeCandidates !== undefined &&
      model.compositionRevision !== undefined &&
      model.selectedLegalEntityId !== undefined
    ) {
      const { compositionRevision, homeCandidates, identity, selectedLegalEntityId } = model;
      void browserRuntime.runPromiseExit(
        shellAuthenticationClientOptionsFromRequest(new Request(globalThis.location.href)).pipe(
          Effect.flatMap((options) =>
            resolveHomeContributionWithWelcome(
              { legalEntityId: selectedLegalEntityId, tenantId: identity.tenantId },
              compositionRevision,
              homeCandidates,
              options,
            ),
          ),
          Effect.orElseSucceed((): ResolvedHomeContribution => ({ contribution: { state: 'unavailable' } })),
          Effect.tap((value) => Effect.sync(() => setResolved({ key, value }))),
        ),
        { signal: controller.signal },
      );
    }
    return () => controller.abort();
  }, [key, model]);
  if (model.state === 'authenticated' && model.homeContribution !== undefined) {
    return model.companyWelcome === undefined
      ? { contribution: model.homeContribution }
      : { contribution: model.homeContribution, welcome: model.companyWelcome };
  }
  return resolved?.key === key ? resolved?.value : undefined;
};

export const HomeView = ({ initialModel }: HomeViewProps) => {
  const { t } = useModernI18n();
  const model = initialModel;
  const controls = useShellControls(model.state === 'authenticated' ? model : undefined);
  const home = useHomeContribution(model);
  // Loaders already send a browser without a live session to sign-in; this is the in-page fallback.
  if (model.state === 'anonymous') {
    return (
      <>
        <UltramodernRouteHead />
        <SignInRedirect reason={model.reason} />
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
        identity={{ displayName: model.identity.displayName, email: model.identity.email }}
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
          <DemoGuideHomeCard legalEntityId={model.selectedLegalEntityId} />
          {model.homeCandidates !== undefined && home === undefined ? <ModulePageSkeleton /> : null}
          {Match.value(home?.contribution).pipe(
            Match.when({ state: 'ready' }, (contribution) => (
              <ResolvedTarget
                key={`${model.identity.principalId}:${model.identity.tenantId}:${model.selectedLegalEntityId}`}
                model={{ routeParams: homeRouteParams, search: '', shell: model, state: 'resolved', target: contribution.target }}
              />
            )),
            // Roles without a module Home component get the shell welcome page: company, where to start, their areas.
            Match.when({ state: 'forbidden' }, () => (
              <HomeWelcome
                companyName={companyName}
                companyWelcome={home?.welcome}
                displayName={model.identity.displayName}
                navigation={model.navigation.items}
                unavailableDeployments={model.navigation.unavailableDeployments}
              />
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
