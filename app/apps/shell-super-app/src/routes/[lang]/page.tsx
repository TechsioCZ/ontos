/* eslint-disable promise/prefer-await-to-then -- React handlers stay synchronous while Effect requests complete asynchronously. */
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { useLoaderData, useNavigate } from '@modern-js/plugin-tanstack/runtime';
import { LinkButton } from '@techsio/ui-kit/atoms/link-button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { Effect } from 'effect';
import { useState } from 'react';
import { runEffectRequest, signOut, switchTenant } from '../../api/auth-client.ts';
import type { SwitchTenantClientError } from '../../api/auth-client.ts';
import type { HomePageModel } from './page.data.ts';
import { AuthenticatedDashboardLayout } from '../shell-frame';
import { UltramodernRouteHead } from '../ultramodern-route-head';

interface HomeViewProps {
  readonly initialModel: HomePageModel;
}

type TenantSwitchFailureState = 'authentication-required' | 'failed';

const tenantSwitchFailureState = (error: SwitchTenantClientError): TenantSwitchFailureState => {
  switch (error._tag) {
    case 'TenantAuthenticationRequiredProblem': {
      return 'authentication-required';
    }
    case 'TenantAccessForbiddenProblem':
    case 'TenantCapabilityUnavailableProblem':
    case 'TenantInternalProblem':
    case 'HttpClientError':
    case 'SchemaError': {
      return 'failed';
    }
    default: {
      return error;
    }
  }
};

export const HomeView = ({ initialModel }: HomeViewProps) => {
  const { language, t } = useModernI18n();
  const navigate = useNavigate();
  const [model, setModel] = useState(initialModel);
  const [logoutPending, setLogoutPending] = useState(false);
  const [logoutFailed, setLogoutFailed] = useState(false);
  const [tenantSwitchPending, setTenantSwitchPending] = useState(false);
  const [tenantSwitchFailed, setTenantSwitchFailed] = useState(false);

  const handleLogout = () => {
    if (logoutPending) {
      return;
    }

    setLogoutPending(true);
    setLogoutFailed(false);
    void runEffectRequest(signOut({ locale: language }))
      .then(() => {
        setModel({ state: 'anonymous' });
      })
      .catch(() => {
        setLogoutFailed(true);
      })
      .finally(() => {
        setLogoutPending(false);
      });
  };

  const handleTenantChange = (tenantId: string) => {
    if (
      model.state === 'anonymous' ||
      tenantSwitchPending ||
      tenantId.length === 0 ||
      tenantId === model.identity.tenantId
    ) {
      return;
    }

    setTenantSwitchPending(true);
    setTenantSwitchFailed(false);
    void runEffectRequest(
      switchTenant({ tenantId }, { locale: language }).pipe(
        Effect.match({
          onFailure: tenantSwitchFailureState,
          onSuccess: () => 'switched' as const,
        }),
      ),
    )
      .then((outcome) => {
        if (outcome === 'authentication-required' || outcome === 'switched') {
          void navigate({ reloadDocument: true, to: '.' });
          return;
        }
        setTenantSwitchFailed(true);
      })
      .catch(() => {
        setTenantSwitchFailed(true);
      })
      .finally(() => {
        setTenantSwitchPending(false);
      });
  };

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

  return (
    <>
      <UltramodernRouteHead />
      <AuthenticatedDashboardLayout
        activeModules={model.activeModules.items.map(({ moduleKey }) => ({ moduleKey }))}
        currentTenantId={model.identity.tenantId}
        identity={{ displayName: model.identity.displayName }}
        logoutPending={logoutPending}
        onLogout={handleLogout}
        onTenantChange={handleTenantChange}
        tenantChoices={model.tenants.items}
        tenantState={model.tenants.state}
        tenantSwitchFailed={tenantSwitchFailed}
        tenantSwitchPending={tenantSwitchPending}
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
          </dl>
          <ul
            aria-describedby={
              model.activeModules.state === 'unavailable' ? 'active-modules-unavailable' : undefined
            }
            aria-label={t('shell.modules.active.label')}
          >
            {model.activeModules.items.map((module) => (
              <li key={module.moduleKey}>
                {t('shell.modules.active.item', {
                  moduleKey: module.moduleKey,
                  state: t('shell.modules.state.active'),
                })}
              </li>
            ))}
          </ul>
          {model.activeModules.state === 'unavailable' ? (
            <StatusText aria-live="polite" id="active-modules-unavailable" showIcon status="error">
              {t('shell.modules.active.unavailable')}
            </StatusText>
          ) : null}
          {logoutFailed ? (
            <StatusText aria-live="polite" showIcon status="error">
              {t('shell.auth.logout.failed')}
            </StatusText>
          ) : null}
        </section>
      </AuthenticatedDashboardLayout>
    </>
  );
};

export default function ShellHome() {
  const initialModel = useLoaderData({ strict: false }) as HomePageModel;
  return <HomeView initialModel={initialModel} />;
}
