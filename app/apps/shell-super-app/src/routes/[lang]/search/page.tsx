import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { useLoaderData, useNavigate, useRouterState } from '@modern-js/plugin-tanstack/runtime';
import { LinkButton } from '@techsio/ui-kit/atoms/link-button';
import { Skeleton } from '@techsio/ui-kit/atoms/skeleton';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { Effect, Fiber, Match, Option, Schema } from 'effect';
import { useEffect, useState } from 'react';

import type { ShellSearchResult } from '../../../../shared/browser-api.ts';
import { browserRuntime } from '../../../runtime/browser-effect-runtime.ts';
import { buildShellNavigation, ShellRouteLink, shellSearchScopeKey } from '../../shell-frame.tsx';
import { shellSearchResultKey } from '../../shell-search-match.ts';
import { ShellSearchFilters, shellSearchFamilyFilterOptions } from '../../shell-search-filters.tsx';
import { ShellSearchResultRow } from '../../shell-search-result-row.tsx';
import { shellSearchGroupOf } from '../../shell-search-resource-types.ts';
import type { ShellSearchPresentationIndex } from '../../shell-search-resource-types.ts';
import { ShellContentLayout } from '../../shell-content-layout.tsx';
import { SignInRedirect } from '../../sign-in-redirect.tsx';
import { useShellControls } from '../../use-shell-controls.ts';
import type { AuthenticatedHomePageModel } from '../home-page-model.ts';
import { searchFailureModel, searchFamiliesFromValue, searchReadyModel } from './search-page-model.ts';
import type { SearchFilterPlan, SearchPageModel } from './search-page-model.ts';

type ReadySearchPageModel = Extract<SearchPageModel, { readonly state: 'ready' }>;

interface SearchPageSearch {
  families?: string;
  q?: string;
}

const cardClassName =
  'ontos-card rounded-lg border border-border-primary/60 bg-base [&_.ontos-card]:border-0 [&_.ontos-card]:bg-transparent [&_.ontos-card]:p-0';

/** The current URL search state; the loader decodes the same q/families shape on the server. */
const RouteSearch = Schema.Struct({
  families: Schema.optionalKey(Schema.String),
  q: Schema.optionalKey(Schema.String),
});

interface RouteSearchState {
  readonly families: string;
  readonly navigationKey: string;
  readonly q: string;
  /** True while the router is still on this search page; a navigation away is never a pending search. */
  readonly samePage: boolean;
}

const useRouteSearchState = (): RouteSearchState =>
  useRouterState({
    select: ({ location, resolvedLocation }) => {
      const decoded = Option.getOrElse(
        Schema.decodeOption(RouteSearch)(location.search),
        (): typeof RouteSearch.Type => ({}),
      );
      return {
        families: searchFamiliesFromValue(decoded.families).join(','),
        navigationKey:
          location.state?.__TSR_key ??
          location.state?.key ??
          `${location.href}\u0000${location.state?.__TSR_index ?? 0}`,
        q: (decoded.q ?? '').trim(),
        samePage: resolvedLocation === undefined || location.pathname === resolvedLocation.pathname,
      };
    },
  });

const searchPageKey = (scopeKey: string, epoch: number, query: string, families: string): string =>
  `${scopeKey}\u0000${epoch}\u0000${query}\u0000${families}`;

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
  index,
  query,
  results,
}: {
  readonly index: ShellSearchPresentationIndex | undefined;
  readonly query: string;
  readonly results: readonly ShellSearchResult[];
}) => {
  const { language, t } = useModernI18n();
  const typeLabelOf = (result: ShellSearchResult): string => {
    const { label } = shellSearchGroupOf(result, index);
    if (label === undefined) {
      return t('shell.search.groups.resource');
    }
    return language?.startsWith('en') ? label.en : label.cs;
  };
  return (
    <ul className="grid max-w-4xl gap-25">
      {results.map((result) => (
        <ShellSearchResultRow
          density="comfortable"
          index={index}
          key={shellSearchResultKey(result)}
          presentation={{ typeLabel: typeLabelOf(result) }}
          query={query}
          result={result}
          ResultLink={ShellRouteLink}
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
  readonly onFamiliesChange: (families: readonly string[]) => void;
  /** Present only while a refined query is loading; the query the person is waiting for. */
  readonly pendingQuery: string | undefined;
  readonly tenantName: string | undefined;
}) => {
  const { language, t } = useModernI18n();
  const { partial, results } = model.response;
  const pending = pendingQuery !== undefined;
  const query = pendingQuery ?? model.query;
  const idle = !pending && query.length === 0;
  const empty = !pending && !idle && results.length === 0;
  const familyOptions = shellSearchFamilyFilterOptions(filters.availableFamilies, language ?? 'cs');
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
      {pending || idle || empty ? null : <SearchResultList index={model.index} query={query} results={results} />}
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

interface ClientSearchState {
  readonly key: string;
  readonly model: SearchPageModel;
}

/**
 * A same-mounted q/filter change does not necessarily re-run the framework loader (its search schema is empty).
 * Fetch the new authorized answer here, keyed by the exact URL; a stale response can never become active because the
 * active answer is selected by key and the previous request is aborted. No loader result or answer is reused.
 */
const useSamePageSearch = ({
  language,
  loaderKey,
  loaderModel,
  navigationEpoch,
  requestKey,
  routeSearch,
  scopeBlocked,
}: {
  readonly language: string;
  readonly loaderKey: string | undefined;
  readonly loaderModel: SearchPageModel;
  readonly navigationEpoch: number;
  readonly requestKey: string;
  readonly routeSearch: RouteSearchState;
  readonly scopeBlocked: boolean;
}): ClientSearchState | null => {
  const [client, setClient] = useState<ClientSearchState | null>(null);
  useEffect(() => {
    const { shell: loaderShell } = loaderModel;
    const authenticatedShell = loaderShell.state === 'authenticated' ? loaderShell : undefined;
    const compositionRevision = authenticatedShell?.compositionRevision;
    const shouldSearch =
      routeSearch.samePage &&
      routeSearch.q.length > 0 &&
      (loaderModel.state === 'ready' || loaderModel.state === 'pending') &&
      (navigationEpoch > 0 || loaderKey !== requestKey) &&
      !scopeBlocked &&
      authenticatedShell !== undefined &&
      compositionRevision !== undefined;
    const controller = shouldSearch ? new AbortController() : undefined;
    let cleanup: (() => void) | undefined;
    if (controller !== undefined && authenticatedShell !== undefined && compositionRevision !== undefined) {
      const requestQuery = routeSearch.q;
      const requestedFamilies = searchFamiliesFromValue(routeSearch.families);
      const fiber = browserRuntime.runFork(
        searchReadyModel({
          compositionRevision,
          options: { locale: language ?? '' },
          query: requestQuery,
          requestedFamilies,
          shell: authenticatedShell,
        }).pipe(
          Effect.match({
            onFailure: (error) => searchFailureModel(error, authenticatedShell, requestQuery),
            onSuccess: (answer) => answer,
          }),
          Effect.flatMap((next) =>
            Effect.sync(() => {
              if (!controller.signal.aborted) {
                setClient({ key: requestKey, model: next });
              }
            }),
          ),
        ),
        { signal: controller.signal },
      );
      cleanup = () => {
        controller.abort();
        browserRuntime.runFork(Fiber.interrupt(fiber));
      };
    }
    return cleanup;
  }, [
    language,
    loaderKey,
    loaderModel,
    navigationEpoch,
    requestKey,
    routeSearch.families,
    routeSearch.q,
    routeSearch.samePage,
    scopeBlocked,
  ]);
  return client;
};

const resolveSearchPageState = ({
  client,
  loaderKey,
  loaderModel,
  navigationEpoch,
  requestKey,
  routeSearch,
}: {
  readonly client: ClientSearchState | null;
  readonly loaderKey: string | undefined;
  readonly loaderModel: SearchPageModel;
  readonly navigationEpoch: number;
  readonly requestKey: string;
  readonly routeSearch: RouteSearchState;
}) => {
  const clientModel = client?.key === requestKey ? client.model : undefined;
  const needsFresh = navigationEpoch > 0 || loaderKey !== requestKey;
  const emptyRouteModel =
    routeSearch.samePage && routeSearch.q.length === 0 && needsFresh && loaderModel.state === 'ready'
      ? ({
          filters: { availableFamilies: [], selectedFamilies: [] },
          query: '',
          response: { partial: false, results: [] },
          shell: loaderModel.shell,
          state: 'ready',
        } satisfies SearchPageModel)
      : undefined;
  // A server render carries no answer yet: show the loading state until the browser search has answered.
  const loaderAnswer =
    loaderModel.state === 'pending'
      ? ({
          filters: { availableFamilies: [], selectedFamilies: [] },
          query: loaderModel.query,
          response: { partial: false, results: [] },
          shell: loaderModel.shell,
          state: 'ready',
        } satisfies SearchPageModel)
      : loaderModel;
  const activeModel = emptyRouteModel ?? (needsFresh ? (clientModel ?? loaderAnswer) : loaderAnswer);
  const searching =
    routeSearch.samePage &&
    routeSearch.q.length > 0 &&
    (loaderKey !== undefined || loaderModel.state === 'pending') &&
    needsFresh &&
    client?.key !== requestKey;
  return { activeModel, searching };
};

const familiesSearch = (query: string, families: readonly string[]): SearchPageSearch => {
  const search: SearchPageSearch = {};
  if (query.length > 0) {
    search.q = query;
  }
  const ordered = [...new Set(families)];
  if (ordered.length > 0) {
    search.families = ordered.join(',');
  }
  return search;
};

const SearchPrincipalRefusal = ({
  controls,
  shell,
}: {
  readonly controls: ReturnType<typeof useShellControls>;
  readonly shell: AuthenticatedHomePageModel;
}) => {
  const { t } = useModernI18n();
  return (
    <ShellContentLayout controls={controls} shell={shell} title={t('shell.search.title')}>
      <StatusText aria-live="polite" showIcon status="error">
        {t('shell.search.unavailable')}
      </StatusText>
    </ShellContentLayout>
  );
};

const useSearchPageState = ({
  language,
  loaderModel,
  routeSearch,
}: {
  readonly language: string;
  readonly loaderModel: SearchPageModel;
  readonly routeSearch: RouteSearchState;
}) => {
  const loaderShell = loaderModel.shell;
  const controls = useShellControls(loaderShell.state === 'authenticated' ? loaderShell : undefined);
  const trustedScopeKey =
    loaderShell.state === 'authenticated'
      ? shellSearchScopeKey({
          compositionRevision: loaderShell.compositionRevision,
          currentLegalEntityId: loaderShell.selectedLegalEntityId,
          currentTenantId: loaderShell.identity.tenantId,
          identity: loaderShell.identity,
          language,
          legalEntitySwitchPending: controls.legalEntitySwitchPending,
          tenantContextActive: loaderShell.contextState === 'tenant_authenticated',
          tenantSwitchPending: controls.tenantSwitchPending,
        })
      : undefined;
  const principalMissing = loaderShell.state === 'authenticated' && loaderShell.identity.principalId === undefined;
  const scopeBlocked =
    loaderShell.state !== 'authenticated' ||
    principalMissing ||
    controls.logoutPending ||
    controls.tenantSwitchPending ||
    controls.legalEntitySwitchPending;
  const scopeKey =
    trustedScopeKey === undefined
      ? 'untrusted-principal'
      : `${trustedScopeKey}\u0000${controls.logoutPending ? 'logout-pending' : 'logout-idle'}`;
  const [navigationState, setNavigationState] = useState(() => ({
    epoch: 0,
    key: routeSearch.navigationKey,
  }));
  if (navigationState.key !== routeSearch.navigationKey) {
    setNavigationState({ epoch: navigationState.epoch + 1, key: routeSearch.navigationKey });
  }
  const navigationEpoch = navigationState.epoch;
  const requestKey = searchPageKey(scopeKey, navigationEpoch, routeSearch.q, routeSearch.families);
  const loaderKey =
    loaderModel.state === 'ready'
      ? searchPageKey(scopeKey, 0, loaderModel.query, loaderModel.filters.selectedFamilies.join(','))
      : undefined;
  const client = useSamePageSearch({
    language,
    loaderKey,
    loaderModel,
    navigationEpoch,
    requestKey,
    routeSearch,
    scopeBlocked,
  });
  const { activeModel, searching } = resolveSearchPageState({
    client,
    loaderKey,
    loaderModel,
    navigationEpoch,
    requestKey,
    routeSearch,
  });
  return { activeModel, controls, principalMissing, searching };
};

const SearchPage = () => {
  const { language, t } = useModernI18n();
  const loaderModel = useLoaderData({ from: '/$lang/search' });
  const routeSearch = useRouteSearchState();
  const navigate = useNavigate();
  const { activeModel, controls, principalMissing, searching } = useSearchPageState({
    language: language ?? '',
    loaderModel,
    routeSearch,
  });
  const { shell } = activeModel;
  if (activeModel.state === 'reload_required' || shell.state === 'reload_required' || controls.reloadRequired) {
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
  if (principalMissing) {
    return <SearchPrincipalRefusal controls={controls} shell={shell} />;
  }
  const legalEntityName = shell.legalEntities.items.find(
    ({ legalEntityId }) => legalEntityId === shell.selectedLegalEntityId,
  )?.legalName;
  const tenantName = shell.tenants.items.find(({ tenantId }) => tenantId === shell.identity.tenantId)?.name;
  const handleFamiliesChange = (families: readonly string[]) => {
    void navigate({ replace: true, search: familiesSearch(routeSearch.q, families), to: '.' });
  };
  const content = Match.value(activeModel).pipe(
    Match.when({ state: 'ready' }, (ready) => (
      <SearchResultsSection
        filters={ready.filters}
        legalEntityName={legalEntityName}
        model={ready}
        onFamiliesChange={handleFamiliesChange}
        pendingQuery={searching ? routeSearch.q : undefined}
        tenantName={tenantName}
      />
    )),
    Match.when({ state: 'unavailable' }, () => <SearchAgendaFallback shell={shell} />),
    Match.orElse(() => (
      <StatusText aria-live="polite" showIcon status="warning">
        {t(`shell.search.${activeModel.state}`)}
      </StatusText>
    )),
  );
  return (
    <ShellContentLayout
      controls={controls}
      shell={shell}
      title={t(activeModel.state === 'unavailable' ? 'shell.search.agenda_title' : 'shell.search.title')}
    >
      {content}
    </ShellContentLayout>
  );
};

export default SearchPage;
