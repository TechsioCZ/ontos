/* eslint-disable no-negated-condition, unicorn/no-negated-condition -- Closed route states read most clearly as error-versus-ready branches. */
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { useLoaderData } from '@modern-js/plugin-tanstack/runtime';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { LinkButton } from '@techsio/ui-kit/atoms/link-button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import type { ShellSearchResult } from '../../../../shared/api.ts';
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
      <main className="shell:mx-auto shell:grid shell:w-full shell:max-w-5xl shell:gap-6 shell:px-4 shell:py-8">
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
  const currentTenantId = model.shell.identity.tenantId;
  const resultKindLabel = (result: ShellSearchResult): string => {
    if (result.kind === 'resource') {
      return result.ref.resourceType;
    }
    return result.kind === 'party' ? t('shell.search.party') : t('shell.search.counterparty');
  };
  const content =
    model.state !== 'ready' ? (
      <StatusText aria-live="polite" showIcon status="error">
        {t(`shell.search.${model.state}`)}
      </StatusText>
    ) : (
      <section
        aria-labelledby="search-results-title"
        className="shell:grid shell:w-full shell:max-w-5xl shell:gap-6"
      >
        <h2 className="shell:text-title-lg" id="search-results-title">
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
          <ul className="shell:grid shell:gap-3">
            {model.response.results.map((result) => (
              <li
                className="shell:grid shell:gap-2"
                key={`${result.ref.moduleId}:${result.ref.resourceType}:${result.ref.resourceId}`}
              >
                <LinkButton
                  href={`/${language}/resources/${encodeURIComponent(result.ref.moduleId)}/${encodeURIComponent(result.ref.resourceType)}/${encodeURIComponent(result.ref.resourceId)}`}
                  variant="secondary"
                >
                  {result.title}
                </LinkButton>
                <div className="shell:flex shell:flex-wrap shell:gap-2">
                  <Badge size="sm" variant="outline">
                    {resultKindLabel(result)}
                  </Badge>
                  {result.kind !== 'resource' &&
                  (result.kind === 'party' ? result.archived : result.party.archived) ? (
                    <Badge size="sm" variant="warning">
                      {t('shell.search.archived')}
                    </Badge>
                  ) : null}
                  {result.kind !== 'resource' &&
                  (result.kind === 'party'
                    ? result.matchedViaAlias
                    : result.party.matchedViaAlias) ? (
                    <Badge size="sm" variant="info">
                      {t('shell.search.alias_match')}
                    </Badge>
                  ) : null}
                  {result.kind === 'counterparty'
                    ? result.currentRoles.map((role) => (
                        <Badge key={role} size="sm" variant="info">
                          {t(`shell.search.roles.${role}`)}
                        </Badge>
                      ))
                    : null}
                  {result.kind === 'counterparty' && result.collision !== undefined ? (
                    <Badge size="sm" variant="warning">
                      {t('shell.search.reconciliation_required')}
                    </Badge>
                  ) : null}
                </div>
                <p className="shell:text-body-sm">
                  {`${result.ref.tenantId ?? currentTenantId}:${result.ref.moduleId}:${result.ref.resourceType}:${result.ref.resourceId}`}
                </p>
                {result.kind === 'counterparty' ? (
                  <>
                    <p className="shell:text-body-sm">
                      {`${t('shell.search.party')}: ${result.party.ref.tenantId}:${result.party.ref.moduleId}:${result.party.ref.resourceType}:${result.party.ref.resourceId}`}
                    </p>
                    <p className="shell:text-body-sm">
                      {`${t('shell.search.legal_entity')}: ${result.legalEntity.legalEntityId}`}
                    </p>
                  </>
                ) : null}
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
      unavailableDeployments={model.shell.navigation.unavailableDeployments}
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
