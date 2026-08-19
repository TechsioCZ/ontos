/* eslint-disable no-negated-condition, unicorn/no-negated-condition -- Closed route states read most clearly as error-versus-ready branches. */
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { useLoaderData } from '@modern-js/plugin-tanstack/runtime';
import { LinkButton } from '@techsio/ui-kit/atoms/link-button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { AuthenticatedDashboardLayout } from '../../shell-frame.tsx';
import { useShellControls } from '../../use-shell-controls.ts';

const SearchPage = () => {
  const { language, t } = useModernI18n();
  const model = useLoaderData({ from: '/$lang/search' });
  const controls = useShellControls(
    model.shell.state === 'authenticated' ? model.shell : undefined,
  );
  if (model.shell.state !== 'authenticated') {
    return (
      <main className="mx-auto grid w-full max-w-5xl gap-6 px-4 py-8">
        <StatusText aria-live="polite" showIcon status="error">
          {t(
            model.shell.state === 'unavailable'
              ? 'shell.dashboard.unavailable'
              : 'shell.search.selection_required',
          )}
        </StatusText>
      </main>
    );
  }
  const content =
    model.state !== 'ready' ? (
      <StatusText aria-live="polite" showIcon status="error">
        {t(`shell.search.${model.state}`)}
      </StatusText>
    ) : (
      <section className="grid w-full max-w-5xl gap-6" aria-labelledby="search-results-title">
        <h2 className="text-title-lg" id="search-results-title">
          {t('shell.search.title')}
        </h2>
        {model.response.partial ? (
          <StatusText aria-live="polite" showIcon status="warning">
            {t('shell.search.partial')}
          </StatusText>
        ) : null}
        {model.response.results.length === 0 ? (
          <StatusText status="default">{t('shell.search.empty')}</StatusText>
        ) : (
          <ul className="grid gap-3">
            {model.response.results.map((result) => (
              <li
                key={`${result.ref.moduleId}:${result.ref.resourceType}:${result.ref.resourceId}`}
              >
                <LinkButton
                  href={`/${language}/resources/${encodeURIComponent(result.ref.moduleId)}/${encodeURIComponent(result.ref.resourceType)}/${encodeURIComponent(result.ref.resourceId)}`}
                  variant="secondary"
                >
                  {result.title}
                </LinkButton>
              </li>
            ))}
          </ul>
        )}
      </section>
    );
  return (
    <AuthenticatedDashboardLayout
      {...(model.shell.selectedLegalEntityId === undefined
        ? {}
        : { currentLegalEntityId: model.shell.selectedLegalEntityId })}
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
      title={t('shell.search.title')}
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

export default SearchPage;
