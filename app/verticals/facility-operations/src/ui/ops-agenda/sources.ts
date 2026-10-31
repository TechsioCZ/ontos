// Loads every Nájempark source the calendar / overview / search read, each through its owner's PUBLIC governed read
// (own gateway audience, own permission check). A source the person may not read, or that is down, is reported
// per source ("bez oprávnění" / "zdroj nedostupný") and never replaced by zeros. Owned by the ops-agenda lane.
import { listCustomers } from '@app/party-registry/api/client';
import { executeRecords as executeAgreements } from '@app/legal-agreements/clients/records';
import { executeRecords as executeOccupancy } from '@app/property-leasing/clients/records';
import { executeRecords as executeProperty } from '@app/property-portfolio/clients/records';
import { executeRecords as executeWork } from '@app/work-tasks/clients/records';
import { Schema, DateTime, Effect, Match, Schedule } from 'effect';
import type { Cause } from 'effect';
import { definePageData, modulePagePreload, pageDataPending } from '@app/shared-contracts/page-data';
import type { PageData, PageDataSnapshot } from '@app/shared-contracts/page-data';
import { useEffect, useState, useSyncExternalStore } from 'react';
import type { OverviewResponse } from '../../../shared/apis/overview.ts';
import { readFinance } from '../../api/finance-reads.ts';
import { executeOverview } from '../../api/overview-client.ts';
import { browserRuntime } from '../../runtime/browser-effect-runtime.ts';
import { loadSalesCases } from './sales-source.ts';

export const SourceStatusSchema = Schema.Literals(['loading', 'ready', 'forbidden', 'unavailable']);
export type SourceStatus = typeof SourceStatusSchema.Type;

const SourceMetadataSchema = Schema.Struct({
  loadedAt: Schema.optionalKey(Schema.DateTimeUtcFromString),
  status: SourceStatusSchema,
});
export type SourceState<Data> = typeof SourceMetadataSchema.Encoded & { readonly data?: Data };

/** Gateway / assertion hiccups (e.g. while the composition is republished) are retried before reporting „forbidden“. */
const transientOverviewFailure = (error: Effect.Error<ReturnType<typeof executeOverview>>) =>
  Match.value(error).pipe(
    Match.tag(
      'OverviewAuthenticationProblem',
      'GatewayAuthenticationRequiredProblem',
      'GatewayReloadRequiredProblem',
      'GatewayUnavailableProblem',
      'OverviewUnavailableProblem',
      () => true,
    ),
    Match.orElse(() => false),
  );

/** The governed read of each source; `ops(true)` also loads the search rows of the provoz records (first search on Přehled). */
const loaders = {
  agreements: () => executeAgreements({}, 'ops-agenda.agreements'),
  finance: () => readFinance('ops-agenda.finance'),
  occupancy: () => executeOccupancy({}, 'ops-agenda.occupancy'),
  ops: (search: boolean) =>
    executeOverview(search ? { includeSearch: true } : {}, 'ops-agenda.overview').pipe(
      Effect.retry({ schedule: Schedule.spaced('700 millis'), times: 2, while: transientOverviewFailure }),
    ),
  parties: () => listCustomers({ includeArchived: false }),
  property: () => executeProperty({}, 'ops-agenda.property'),
  sales: () => loadSalesCases('ops-agenda.sales'),
  work: () => executeWork({}, 'ops-agenda.work'),
};
type Loaders = { readonly [Key in keyof typeof loaders]: ReturnType<(typeof loaders)[Key]> };
type Success<Key extends keyof Loaders> = Effect.Success<Loaders[Key]>;
type SourceFailure = Effect.Error<Loaders[keyof Loaders]> | Cause.TimeoutError;

export type PropertyData = Success<'property'>;
export type AgreementsData = Success<'agreements'>;
export type OccupancyData = Success<'occupancy'>;
export type WorkData = Success<'work'>;
export type FinanceData = Success<'finance'>;
export type PartiesData = Success<'parties'>;
export type SalesData = Success<'sales'>;

export interface RentalOverviewSources {
  readonly agreements: SourceState<AgreementsData>;
  readonly finance: SourceState<FinanceData>;
  readonly occupancy: SourceState<OccupancyData>;
  /** Provoz agendas, already reduced on the server to what these pages show (overview read). */
  readonly ops: SourceState<OverviewResponse>;
  readonly parties: SourceState<PartiesData>;
  readonly property: SourceState<PropertyData>;
  /** Open sales cases (sales pipeline). Only the overview tile reads it; the calendar and search do not. */
  readonly sales: SourceState<SalesData>;
  readonly work: SourceState<WorkData>;
}

export type SourceKey = keyof RentalOverviewSources;
export const sourceKeys: readonly SourceKey[] = [
  'property',
  'occupancy',
  'agreements',
  'work',
  'finance',
  'ops',
  'parties',
];

const failureStatus = (error: SourceFailure): SourceStatus =>
  Match.value(error).pipe(
    Match.whenOr(
      { _tag: 'RecordsForbiddenProblem' },
      { _tag: 'RecordsAuthenticationProblem' },
      { _tag: 'OverviewForbiddenProblem' },
      { _tag: 'OverviewAuthenticationProblem' },
      { _tag: 'CustomerListForbiddenProblem' },
      { _tag: 'CustomerListAuthenticationProblem' },
      { _tag: 'GatewayForbiddenProblem' },
      { _tag: 'GatewayAuthenticationRequiredProblem' },
      (): SourceStatus => 'forbidden',
    ),
    Match.orElse((): SourceStatus => 'unavailable'),
  );

const LoadedTimestampSchema = Schema.Struct({ loadedAt: Schema.DateTimeUtcFromString });
type Loaded<A> = typeof LoadedTimestampSchema.Encoded & { readonly data: A };

const timed = Effect.fn('FacilityOperations.loadTimedSource')(function* timedSource<A, E>(effect: Effect.Effect<A, E>) {
  const data = yield* effect.pipe(Effect.timeout('12 seconds'));
  const loadedAt = DateTime.formatIso(yield* DateTime.now);
  return { data, loadedAt };
});

/** Every source but `ops` is one read per document. */
type Whole = 'all';
const whole: Whole = 'all';

const sourceData = <A, E>(load: () => Effect.Effect<A, E>) =>
  definePageData({ key: (input: Whole) => input, load: () => timed(load()), runtime: browserRuntime });

/**
 * One page-data store per source (one entry per document; `ops` has a second entry with the search rows). The Shell
 * fills them through `preloadPage` before it reveals Přehled or Moje agenda, so KPI tiles render values in the first
 * commit; each source still settles on its own, so a slow or forbidden one never blocks the rest.
 */
const sourceStores = {
  agreements: sourceData(loaders.agreements),
  finance: sourceData(loaders.finance),
  occupancy: sourceData(loaders.occupancy),
  parties: sourceData(loaders.parties),
  property: sourceData(loaders.property),
  sales: sourceData(loaders.sales),
  work: sourceData(loaders.work),
};
const opsStore = definePageData({
  key: (search: boolean) => (search ? 'search' : 'base'),
  load: (search: boolean) => timed(loaders.ops(search)),
  runtime: browserRuntime,
});
const wholeKeys = [
  'agreements',
  'finance',
  'occupancy',
  'parties',
  'property',
  'sales',
  'work',
] as const satisfies readonly (keyof typeof sourceStores)[];
const SOURCE_CONCURRENCY = 8;

/** `preloadPage` of Přehled and Moje agenda: all eight sources (the provoz source without search rows). */
export const preloadRentalOverviewSources = modulePagePreload(
  () => opsStore.preload(false),
  ...wholeKeys.map((key) => () => sourceStores[key].preload(whole)),
);

const stateOf = <A, E extends SourceFailure>(snapshot: PageDataSnapshot<Loaded<A>, E>): SourceState<A> => {
  if (snapshot.state === 'pending') {
    return { status: 'loading' };
  }
  if (snapshot.state === 'failed') {
    return { status: failureStatus(snapshot.error) };
  }
  return { data: snapshot.value.data, loadedAt: snapshot.value.loadedAt, status: 'ready' };
};

const pendingSnapshot = () => pageDataPending;

const useSource = <A, E extends SourceFailure>(store: PageData<Whole, Loaded<A>, E>) => {
  const snapshot = useSyncExternalStore(store.subscribe, () => store.snapshot(whole), pendingSnapshot);
  useEffect(() => store.ensure(whole), [store]);
  return snapshot;
};

/** Display names of properties, units (`Budova › Jednotka`) and counterparties, keyed by resource id. */
export const nameLookup = (sources: RentalOverviewSources): ReadonlyMap<string, string> => {
  const names = new Map<string, string>();
  const property = sources.property.data;
  if (property !== undefined) {
    for (const entry of property.properties) {
      names.set(entry.propertyRef.resourceId, entry.name);
    }
    for (const unit of property.units) {
      const building = names.get(unit.propertyRef.resourceId);
      names.set(unit.unitRef.resourceId, building === undefined ? unit.name : `${building} › ${unit.name}`);
    }
  }
  for (const customer of sources.parties.data ?? []) {
    if (customer.displayName !== null) {
      names.set(customer.counterpartyRef.resourceId, customer.displayName);
      names.set(customer.counterpartyId, customer.displayName);
    }
  }
  return names;
};

/**
 * Reads all sources from their stores (normally already filled before the page is revealed); each settles
 * independently. Search rows of the provoz records are loaded only after `loadSearch()` (the first search on Přehled);
 * until they arrive the provoz source without them stays on screen.
 */
export const useRentalOverviewSources = () => {
  const [search, setSearch] = useState(false);
  const opsBase = useSyncExternalStore(opsStore.subscribe, () => opsStore.snapshot(false), pendingSnapshot);
  const opsSearch = useSyncExternalStore(
    opsStore.subscribe,
    search ? () => opsStore.snapshot(true) : pendingSnapshot,
    pendingSnapshot,
  );
  useEffect(() => opsStore.ensure(false), []);
  useEffect(() => {
    if (search) {
      opsStore.ensure(true);
    }
  }, [search]);
  const ops = search && opsSearch.state !== 'pending' ? opsSearch : opsBase;
  const agreements = useSource(sourceStores.agreements);
  const finance = useSource(sourceStores.finance);
  const occupancy = useSource(sourceStores.occupancy);
  const parties = useSource(sourceStores.parties);
  const property = useSource(sourceStores.property);
  const sales = useSource(sourceStores.sales);
  const work = useSource(sourceStores.work);

  const sources: RentalOverviewSources = {
    agreements: stateOf(agreements),
    finance: stateOf(finance),
    occupancy: stateOf(occupancy),
    ops: stateOf(ops),
    parties: stateOf(parties),
    property: stateOf(property),
    sales: stateOf(sales),
    work: stateOf(work),
  };
  const reload = () =>
    Effect.all([opsStore.refresh(search), ...wholeKeys.map((key) => sourceStores[key].refresh(whole))], {
      concurrency: SOURCE_CONCURRENCY,
      discard: true,
    });
  const loadSearch = () => setSearch(true);
  const names = nameLookup(sources);
  return { loadSearch, names, reload, sources };
};

/** `true` once no source is still loading. */
export const allSettled = (sources: RentalOverviewSources) =>
  sourceKeys.every((key) => sources[key].status !== 'loading');
