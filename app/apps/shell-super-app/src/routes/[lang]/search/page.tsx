/* eslint-disable no-negated-condition, unicorn/no-negated-condition -- Closed route states read most clearly as error-versus-ready branches. expires: 2026-12-31. */
import { Link as LocalizedLink, useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { useLoaderData } from '@modern-js/plugin-tanstack/runtime';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { LinkButton } from '@techsio/ui-kit/atoms/link-button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { Match } from 'effect';

import type { ShellSearchResult } from '../../../../shared/api.ts';
import { ShellContentLayout } from '../../shell-content-layout.tsx';
import { useShellControls } from '../../use-shell-controls.ts';

const SearchResultItem = ({
  currentTenantId,
  result,
}: {
  readonly currentTenantId: string;
  readonly result: ShellSearchResult;
}) => {
  const { t } = useModernI18n();
  const party = Match.value(result).pipe(
    Match.when({ kind: 'resource' }, () => null),
    Match.when({ kind: 'party' }, (partyResult) => partyResult),
    Match.when({ kind: 'counterparty' }, (counterparty) => counterparty.party),
    Match.exhaustive,
  );
  const resultKindLabel = (): string => {
    if (result.kind === 'resource') {
      return result.ref.resourceType;
    }
    return result.kind === 'party' ? t('shell.search.party') : t('shell.search.counterparty');
  };
  return (
    <li
      className="shell:grid shell:gap-2"
      key={`${result.ref.moduleId}:${result.ref.resourceType}:${result.ref.resourceId}`}
    >
      <LinkButton
        as={LocalizedLink}
        params={{
          moduleId: result.ref.moduleId,
          resourceId: result.ref.resourceId,
          resourceType: result.ref.resourceType,
        }}
        to="/resources/$moduleId/$resourceType/$resourceId"
        variant="secondary"
      >
        {result.title}
      </LinkButton>
      <div className="shell:flex shell:flex-wrap shell:gap-2">
        <Badge size="sm" variant="outline">
          {resultKindLabel()}
        </Badge>
        {party?.archived === true ? (
          <Badge size="sm" variant="warning">
            {t('shell.search.archived')}
          </Badge>
        ) : null}
        {party?.matchedViaAlias === true ? (
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
  );
};

const SearchPage = () => {
  const { t } = useModernI18n();
  const model = useLoaderData({ from: '/$lang/search' });
  const controls = useShellControls(model.shell.state === 'authenticated' ? model.shell : undefined);
  if (model.shell.state !== 'authenticated') {
    return (
      <main className="shell:mx-auto shell:grid shell:w-full shell:max-w-5xl shell:gap-6 shell:px-4 shell:py-8">
        <StatusText aria-live="polite" showIcon status="error">
          {t(model.shell.state === 'unavailable' ? 'shell.dashboard.unavailable' : 'shell.search.selection_required')}
        </StatusText>
      </main>
    );
  }
  const currentTenantId = model.shell.identity.tenantId;
  const content =
    model.state !== 'ready' ? (
      <StatusText aria-live="polite" showIcon status="error">
        {t(`shell.search.${model.state}`)}
      </StatusText>
    ) : (
      <section aria-labelledby="search-results-title" className="shell:grid shell:w-full shell:max-w-5xl shell:gap-6">
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
              <SearchResultItem
                currentTenantId={currentTenantId}
                key={`${result.ref.moduleId}:${result.ref.resourceType}:${result.ref.resourceId}`}
                result={result}
              />
            ))}
          </ul>
        )}
      </section>
    );
  return (
    <ShellContentLayout controls={controls} shell={model.shell} title={t('shell.search.title')}>
      {content}
    </ShellContentLayout>
  );
};

export default SearchPage;
