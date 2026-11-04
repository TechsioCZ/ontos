import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { useLoaderData, useNavigate, useRouterState } from '@modern-js/plugin-tanstack/runtime';
import { LinkButton } from '@techsio/ui-kit/atoms/link-button';
import { Skeleton } from '@techsio/ui-kit/atoms/skeleton';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { Match, Option, Schema } from 'effect';

import type { ShellSearchResult } from '../../../../shared/api.ts';
import { buildShellNavigation, ShellRouteLink } from '../../shell-frame.tsx';
import { shellSearchFamiliesInOrder, shellSearchResultKey } from '../../shell-search-match.ts';
import type { ShellSearchFamilyKey } from '../../shell-search-match.ts';
import { ShellSearchFilters } from '../../shell-search-filters.tsx';
import { ShellSearchResultRow } from '../../shell-search-result-row.tsx';
import {
  shellSearchGroupOf,
  shellSearchPresentationContext,
  shellSearchResultTarget,
} from '../../shell-search-resource-types.ts';
import { ShellContentLayout } from '../../shell-content-layout.tsx';
import { SignInRedirect } from '../../sign-in-redirect.tsx';
import { useShellControls } from '../../use-shell-controls.ts';
import type { AuthenticatedHomePageModel } from '../home-page-model.ts';
import type { SearchFilterPlan, SearchPageModel } from './search-page-model.ts';

type ReadySearchPageModel = Extract<SearchPageModel, { readonly state: 'ready' }>;

type ShellSearchContext = ReturnType<typeof shellSearchPresentationContext>;

interface SearchPageSearch {
  families?: string;
  q?: string;
}

const cardClassName =
  'ontos-card rounded-lg border border-border-primary/60 bg-base [&_.ontos-card]:border-0 [&_.ontos-card]:bg-transparent [&_.ontos-card]:p-0';

/** The search state the route accepts; the loader decodes the same shape from its request. */
const PendingSearch = Schema.Struct({
  q: Schema.optionalKey(Schema.String),
});

/**
 * The query of a refined search whose loader has not answered yet, or `undefined` when this page is settled. The
 * previous answer is then replaced by the searching state, and the scope line names the query that is being searched
 * instead of presenting the previous one as current. A navigation to another page is not a pending search.
 */
const usePendingSearchQuery = (): string | undefined =>
  useRouterState({
    select: ({ location, resolvedLocation }) =>
      resolvedLocation !== undefined &&
      location.pathname === resolvedLocation.pathname &&
      location.href !== resolvedLocation.href
        ? (Option.getOrUndefined(Schema.decodeOption(PendingSearch)(location.search))?.q ?? '').trim()
        : undefined,
  });

/** Three row placeholders; the searching sentence next to them is what assistive technology announces. */
const SearchResultsPlaceholder = () => (
  <ul aria-hidden className="grid gap-25">
    {[0, 1, 2].map((row) => (
      <li className="grid gap-50 px-250 py-200" key={row}>
        <Skeleton.Text noOfLines={1} size="sm" />
        <Skeleton.Text containerClassName="w-2/5" noOfLines={1} size="sm" />
      </li>
    ))}
  </ul>
);

interface SearchScopeEntry {
  readonly key: string;
  /** An existing `shell.*` translation key, already translated by the caller. */
  readonly label: string;
  readonly value: string;
}

/**
 * What was searched and where: the query plus the selected company and tenant the answer was authorized in, so a
 * shared or reloaded results page explains itself instead of showing unexplained hits.
 */
const SearchScope = ({ entries }: { readonly entries: readonly SearchScopeEntry[] }) => (
  <dl className="flex flex-wrap items-baseline gap-x-300 gap-y-50 text-sm">
    {entries.map(({ key, label, value }) => (
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-100" key={key}>
        <dt className="shrink-0 text-fg-secondary">{label}</dt>
        <dd className="min-w-0 break-words font-medium text-fg-primary">{value}</dd>
      </div>
    ))}
  </dl>
);

/**
 * The hits in the one server order, with the record type as translated context under each title. A flat list is
 * deliberate: fixed family sections would move a higher-ranked hit below a looser family, and the server already
 * ranked and authorized the complete answer. Rows open the owner record and carry no invented rank, count or reason.
 */
const SearchResultList = ({
  context,
  query,
  results,
}: {
  readonly context: ShellSearchContext;
  readonly query: string;
  readonly results: readonly ShellSearchResult[];
}) => {
  const { t } = useModernI18n();
  return (
    <ul className="grid max-w-4xl gap-25">
      {results.map((result) => (
        <ShellSearchResultRow
          density="comfortable"
          key={shellSearchResultKey(result)}
          presentation={{ typeLabel: t(`shell.search.groups.${shellSearchGroupOf(result, context)}`) }}
          query={query}
          result={result}
          ResultLink={ShellRouteLink}
          target={shellSearchResultTarget(result, context)}
        />
      ))}
    </ul>
  );
};

/**
 * The answered search: the scope it was run in, one announced state sentence (searching, incomplete, empty), and the
 * grouped hits. Every state is a sentence the person can act on; nothing here claims a total the Shell did not receive.
 */
const SearchResultsSection = ({
  filters,
  legalEntityName,
  model,
  onFamiliesChange,
  pendingQuery,
  tenantName,
}: {
  readonly filters: SearchFilterPlan;
  readonly legalEntityName: string | undefined;
  readonly model: ReadySearchPageModel;
  readonly onFamiliesChange: (families: readonly ShellSearchFamilyKey[]) => void;
  /** Present only while a refined query is loading; the query the person is waiting for. */
  readonly pendingQuery: string | undefined;
  readonly tenantName: string | undefined;
}) => {
  const { t } = useModernI18n();
  const context = shellSearchPresentationContext(
    model.shell.state === 'authenticated' ? model.shell.navigation.items : [],
  );
  const { partial, results } = model.response;
  const pending = pendingQuery !== undefined;
  const query = pendingQuery ?? model.query;
  const idle = !pending && query.length === 0;
  const empty = !pending && !idle && results.length === 0;
  const familyOptions = filters.availableFamilies.map(({ groups, key }) => ({
    key,
    // The family's own visible groups name it in the reader's language; nothing is invented or hardcoded.
    label: groups.map((group) => t(`shell.search.groups.${group}`)).join(' · '),
  }));
  const entries: readonly SearchScopeEntry[] = [
    ...(query.length === 0 ? [] : [{ key: 'query', label: t('shell.search.label'), value: query }]),
    ...(legalEntityName === undefined
      ? []
      : [{ key: 'legalEntity', label: t('shell.search.legal_entity'), value: legalEntityName }]),
    ...(tenantName === undefined
      ? []
      : [{ key: 'tenant', label: t('shell.dashboard.tenant.accessibleLabel'), value: tenantName }]),
  ];
  return (
    <div aria-busy={pending} className="grid gap-300">
      <header className="border-border-primary/60 border-b pb-200">
        <SearchScope entries={entries} />
      </header>
      {familyOptions.length === 0 ? null : (
        <ShellSearchFilters
          disabled={pending}
          label={t('shell.search.label')}
          onChange={onFamiliesChange}
          options={familyOptions}
          selected={filters.selectedFamilies}
        />
      )}
      <div aria-live="polite" className="grid gap-100">
        {pending ? <StatusText status="default">{t('shell.search.suggestions.loading')}</StatusText> : null}
        {partial && !pending ? (
          <StatusText showIcon status="warning">
            {t('shell.search.partial')}
          </StatusText>
        ) : null}
        {idle ? <StatusText status="default">{t('shell.search.placeholder')}</StatusText> : null}
        {empty ? (
          // An incomplete answer may not claim that nothing was found; it only lists nothing yet.
          <StatusText status="default">
            {partial ? t('shell.search.empty') : t('shell.search.suggestions.empty', { query })}
          </StatusText>
        ) : null}
      </div>
      {pending ? <SearchResultsPlaceholder /> : null}
      {pending || idle || empty ? null : <SearchResultList context={context} query={query} results={results} />}
    </div>
  );
};

/**
 * When the Shell cannot search at all, the agendas the person may open stay one click away, so the page still leads
 * somewhere useful instead of ending in an error line.
 */
const SearchAgendaFallback = ({ shell }: { readonly shell: AuthenticatedHomePageModel }) => {
  const { language, t } = useModernI18n();
  const agendaLinks = buildShellNavigation(
    { language: language ?? '', navigation: shell.navigation.items, unavailableDeployments: [] },
    t,
  ).groups.flatMap(({ links }) => links.filter(({ enabled, href }) => enabled && href !== null));
  if (agendaLinks.length === 0) {
    return <StatusText status="default">{t('shell.search.agenda_hint')}</StatusText>;
  }
  return (
    <section aria-labelledby="search-agenda-title" className={`${cardClassName} grid w-full max-w-2xl gap-200 p-300`}>
      <h2 className="font-semibold text-fg-primary text-md" id="search-agenda-title">
        {t('shell.search.agenda_title')}
      </h2>
      <p className="text-fg-secondary text-sm">{t('shell.search.agenda_hint')}</p>
      <ul className="grid gap-150 md:grid-cols-2">
        {agendaLinks.map((link) => (
          <li key={link.key}>
            <LinkButton
              as={ShellRouteLink}
              block
              className="justify-start hover:bg-overlay"
              icon={link.icon}
              size="sm"
              theme="unstyled"
              to={link.href ?? '/'}
              variant="secondary"
            >
              {link.label}
            </LinkButton>
          </li>
        ))}
      </ul>
    </section>
  );
};

const SearchPage = () => {
  const { t } = useModernI18n();
  const model = useLoaderData({ from: '/$lang/search' });
  const { shell } = model;
  const navigate = useNavigate();
  const pendingQuery = usePendingSearchQuery();
  const controls = useShellControls(shell.state === 'authenticated' ? shell : undefined);
  if (model.state === 'reload_required' || shell.state === 'reload_required' || controls.reloadRequired) {
    return (
      <main className="shell:mx-auto shell:grid shell:w-full shell:max-w-5xl shell:gap-6 shell:px-4 shell:py-8">
        <StatusText aria-live="polite" showIcon status="error">
          {t('shell.moduleTarget.reload_required')}
        </StatusText>
      </main>
    );
  }
  if (shell.state === 'anonymous') {
    return <SignInRedirect reason={shell.reason} />;
  }
  if (shell.state !== 'authenticated') {
    return (
      <main className="shell:mx-auto shell:grid shell:w-full shell:max-w-5xl shell:gap-6 shell:px-4 shell:py-8">
        <StatusText aria-live="polite" showIcon status="error">
          {t(shell.state === 'unavailable' ? 'shell.dashboard.unavailable' : 'shell.search.selection_required')}
        </StatusText>
      </main>
    );
  }
  const legalEntityName = shell.legalEntities.items.find(
    ({ legalEntityId }) => legalEntityId === shell.selectedLegalEntityId,
  )?.legalName;
  const tenantName = shell.tenants.items.find(({ tenantId }) => tenantId === shell.identity.tenantId)?.name;
  const handleFamiliesChange = (families: readonly ShellSearchFamilyKey[]) => {
    const ordered = shellSearchFamiliesInOrder(families);
    const search: SearchPageSearch = {};
    if (model.query.length > 0) {
      search.q = model.query;
    }
    if (ordered.length > 0) {
      search.families = ordered.join(',');
    }
    void navigate({ replace: true, search, to: '.' });
  };
  const content = Match.value(model).pipe(
    Match.when({ state: 'ready' }, (ready) => (
      <SearchResultsSection
        filters={ready.filters}
        legalEntityName={legalEntityName}
        model={ready}
        onFamiliesChange={handleFamiliesChange}
        pendingQuery={pendingQuery}
        tenantName={tenantName}
      />
    )),
    Match.when({ state: 'unavailable' }, () => <SearchAgendaFallback shell={shell} />),
    Match.orElse(() => (
      <StatusText aria-live="polite" showIcon status="warning">
        {t(`shell.search.${model.state}`)}
      </StatusText>
    )),
  );
  return (
    <ShellContentLayout
      controls={controls}
      shell={shell}
      title={t(model.state === 'unavailable' ? 'shell.search.agenda_title' : 'shell.search.title')}
    >
      {content}
    </ShellContentLayout>
  );
};

export default SearchPage;
