/* eslint-disable promise/prefer-await-to-then -- React handlers stay synchronous while Effect requests complete asynchronously. */
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { useLoaderData } from '@modern-js/plugin-tanstack/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import { LinkButton } from '@techsio/ui-kit/atoms/link-button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { useState } from 'react';
import { runEffectRequest, signOut } from '../../api/auth-client.ts';
import type { HomePageModel } from './page.data.ts';
import { UltramodernRouteHead } from '../ultramodern-route-head';

interface HomeViewProps {
  readonly initialModel: HomePageModel;
}

export const HomeView = ({ initialModel }: HomeViewProps) => {
  const { language, t } = useModernI18n();
  const [model, setModel] = useState(initialModel);
  const [logoutPending, setLogoutPending] = useState(false);
  const [logoutFailed, setLogoutFailed] = useState(false);

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
      <main className="flex min-h-screen items-center justify-center bg-(--color-page-bg) p-4 text-(--color-page-fg)">
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
          <Button
            block
            disabled={logoutPending}
            isLoading={logoutPending}
            loadingText={t('shell.auth.logout.pending')}
            onClick={handleLogout}
            size="md"
            theme="solid"
            type="button"
            variant="primary"
          >
            {t('shell.auth.logout.action')}
          </Button>
        </section>
      </main>
    </>
  );
};

export default function ShellHome() {
  const initialModel = useLoaderData({ strict: false }) as HomePageModel;
  return <HomeView initialModel={initialModel} />;
}
