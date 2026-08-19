/* eslint-disable promise/prefer-await-to-then -- React handlers stay synchronous while Effect requests complete asynchronously. */
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { useLoaderData } from '@modern-js/plugin-tanstack/runtime';
import { LinkButton } from '@techsio/ui-kit/atoms/link-button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { useState } from 'react';
import type { HomePageModel } from './page.data.ts';
import { AuthenticatedDashboardLayout } from '../shell-frame';
import { UltramodernRouteHead } from '../ultramodern-route-head';
import { useShellControls } from '../use-shell-controls.ts';

interface HomeViewProps {
  readonly initialModel: HomePageModel;
}

export const HomeView = ({ initialModel }: HomeViewProps) => {
  const { language, t } = useModernI18n();
  const [model, setModel] = useState(initialModel);
  const controls = useShellControls(model.state === 'authenticated' ? model : undefined, () =>
    setModel({ state: 'anonymous' }),
  );

  if (model.state === 'anonymous') {
    return (
      <>
        <UltramodernRouteHead />
        <main className="flex min-h-screen items-center justify-center bg-(--color-page-bg) p-4">
          <LinkButton href={`/${language}/login`} size="md" theme="solid" variant="primary">
            {t('shell.auth.loginLink')}
          </LinkButton>
        </main>
      </>
    );
  }

  if (model.state === 'unavailable') {
    return (
      <>
        <UltramodernRouteHead />
        <main className="flex min-h-screen items-center justify-center bg-(--color-page-bg) p-4">
          <StatusText aria-live="polite" showIcon status="error">
            {t('shell.dashboard.unavailable')}
          </StatusText>
        </main>
      </>
    );
  }

  return (
    <>
      <UltramodernRouteHead />
      <AuthenticatedDashboardLayout
        {...(model.selectedLegalEntityId === undefined
          ? {}
          : { currentLegalEntityId: model.selectedLegalEntityId })}
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
      >
        <section
          aria-label={t('shell.auth.identity.title')}
          className="flex w-full max-w-lg flex-col gap-4 bg-(--color-surface) p-6"
        >
          <dl className="grid gap-3">
            <div>
              <dt className="font-semibold">{t('shell.auth.identity.displayName')}</dt>
              <dd>{model.identity.displayName}</dd>
            </div>
            <div>
              <dt className="font-semibold">{t('shell.auth.identity.email')}</dt>
              <dd>{model.identity.email}</dd>
            </div>
            <div>
              <dt className="font-semibold">{t('shell.auth.identity.principal')}</dt>
              <dd>{model.identity.principalId}</dd>
            </div>
            <div>
              <dt className="font-semibold">{t('shell.auth.identity.tenant')}</dt>
              <dd>{model.identity.tenantId}</dd>
            </div>
            {model.contextState === 'authenticated' ? (
              <div>
                <dt className="font-semibold">{t('shell.auth.identity.legalEntity')}</dt>
                <dd>{model.selectedLegalEntityId}</dd>
              </div>
            ) : null}
          </dl>
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
            <StatusText
              aria-live="polite"
              id="module-navigation-unavailable"
              showIcon
              status="error"
            >
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
  const initialModel = useLoaderData({ from: '/$lang' });
  return <HomeView initialModel={initialModel} />;
};

export default ShellHome;
