import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { useLoaderData } from '@modern-js/plugin-tanstack/runtime';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { Effect } from 'effect';
import { useEffect, useState } from 'react';
import { runEffectRequest } from '../../../../api/auth-client.ts';
import type { ApprovedVerticalPageComponent } from '../../../../api/vertical-clients.ts';
import { findApprovedVerticalPageClient } from '../../../../api/vertical-clients.ts';
import { resolveThenLoadModuleTarget } from '../../../module-entrypoint-loader.ts';
import { AuthenticatedDashboardLayout } from '../../../shell-frame.tsx';
import { useShellControls } from '../../../use-shell-controls.ts';
import type { ModuleTargetPageModel } from './page.data.ts';

type RemoteState =
  | { readonly state: 'loading' | 'unavailable' }
  | { readonly Component: ApprovedVerticalPageComponent; readonly state: 'ready' };

const ResolvedTarget = ({
  model,
}: {
  readonly model: Extract<ModuleTargetPageModel, { state: 'resolved' }>;
}) => {
  const { t } = useModernI18n();
  const client = findApprovedVerticalPageClient(model.target);
  const [remote, setRemote] = useState<RemoteState>(() =>
    client === undefined ? { state: 'unavailable' } : { state: 'loading' },
  );

  useEffect(() => {
    if (client === undefined) {
      return;
    }
    let current = true;
    const load = async () => {
      try {
        const { default: Component } = await runEffectRequest(
          resolveThenLoadModuleTarget(Effect.succeed(model.target), () =>
            Effect.tryPromise(() => client.load()),
          ),
        );
        if (current) {
          setRemote({ Component, state: 'ready' });
        }
      } catch {
        if (current) {
          setRemote({ state: 'unavailable' });
        }
      }
    };
    void load();
    return () => {
      current = false;
    };
  }, [client, model.target]);

  if (remote.state === 'ready') {
    return <remote.Component routeParams={model.routeParams} target={model.target} />;
  }
  return (
    <StatusText
      aria-live="polite"
      showIcon
      status={remote.state === 'loading' ? 'default' : 'error'}
    >
      {t(`shell.moduleTarget.${remote.state}`)}
    </StatusText>
  );
};

const ModuleTargetPage = () => {
  const { t } = useModernI18n();
  const model: ModuleTargetPageModel = useLoaderData({ strict: false });
  const controls = useShellControls(
    model.shell.state === 'authenticated' ? model.shell : undefined,
  );
  if (model.shell.state !== 'authenticated') {
    return (
      <main className="shell:mx-auto shell:grid shell:w-full shell:max-w-5xl shell:gap-6 shell:px-4 shell:py-8">
        <StatusText aria-live="polite" showIcon status="error">
          {t(
            model.shell.state === 'unavailable'
              ? 'shell.dashboard.unavailable'
              : 'shell.moduleTarget.selection_required',
          )}
        </StatusText>
      </main>
    );
  }
  const content =
    model.state === 'resolved' ? (
      <ResolvedTarget model={model} />
    ) : (
      <StatusText aria-live="polite" showIcon status="error">
        {t(`shell.moduleTarget.${model.state}`)}
      </StatusText>
    );
  return (
    <AuthenticatedDashboardLayout
      {...(model.shell.selectedLegalEntityId === undefined
        ? {}
        : { currentLegalEntityId: model.shell.selectedLegalEntityId })}
      {...(model.state === 'resolved' ? { currentModuleId: model.target.moduleId } : {})}
      currentTenantId={model.shell.identity.tenantId}
      homeCurrent={false}
      identity={{ displayName: model.shell.identity.displayName }}
      legalEntityChoices={model.shell.legalEntities.items}
      legalEntityState={model.shell.legalEntities.state}
      legalEntitySwitchFailed={controls.legalEntitySwitchFailed}
      legalEntitySwitchPending={controls.legalEntitySwitchPending}
      logoutPending={controls.logoutPending}
      navigation={model.shell.navigation.items}
      onLegalEntityChange={controls.handleLegalEntityChange}
      onLogout={controls.handleLogout}
      onSearch={controls.handleSearch}
      onTenantChange={controls.handleTenantChange}
      tenantChoices={model.shell.tenants.items}
      tenantState={model.shell.tenants.state}
      tenantSwitchFailed={controls.tenantSwitchFailed}
      tenantSwitchPending={controls.tenantSwitchPending}
    >
      {controls.logoutFailed ? (
        <StatusText aria-live="polite" showIcon status="error">
          {t('shell.auth.logout.failed')}
        </StatusText>
      ) : null}
      {content}
    </AuthenticatedDashboardLayout>
  );
};

export default ModuleTargetPage;
