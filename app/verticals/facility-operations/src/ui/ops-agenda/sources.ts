// @effect-diagnostics asyncFunction:off globalDate:off
// Loads every Siampark source the calendar / overview / search read, each through its owner's PUBLIC governed read
// (own gateway audience, own permission check). A source the person may not read, or that is down, is reported
// per source ("bez oprávnění" / "zdroj nedostupný") and never replaced by zeros. Owned by the ops-agenda lane.
import { listCustomers } from '@app/party-registry/api/client';
import { executeRecords as executeAgreements } from '@app/legal-agreements/clients/records';
import { executeRecords as executeOccupancy } from '@app/property-leasing/clients/records';
import { executeRecords as executeProperty } from '@app/property-portfolio/clients/records';
import { executeRecords as executeWork } from '@app/work-tasks/clients/records';
import { Effect, Schedule } from 'effect';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { OverviewResponse } from '../../../shared/apis/overview.ts';
import { readFinance } from '../../api/finance-reads.ts';
import { executeOverview } from '../../api/overview-client.ts';
import { browserRuntime } from '../../runtime/browser-effect-runtime.ts';
import { loadSalesCases } from './sales-source.ts';

export type SourceStatus = 'loading' | 'ready' | 'forbidden' | 'unavailable';

export interface SourceState<Data> {
  readonly status: SourceStatus;
  readonly data?: Data;
  /** ISO timestamp of the successful read. */
  readonly loadedAt?: string;
}

/** Gateway / assertion hiccups (e.g. while the composition is republished) are retried before reporting „forbidden“. */
const transientOverviewFailure = (error: { readonly _tag: string }) =>
  /^(OverviewAuthentication|GatewayAuthenticationRequired|GatewayReloadRequired|GatewayUnavailable|OverviewUnavailable)/u.test(
    error._tag,
  );

/** `search`: Přehled also needs the search rows of the provoz records; Moje agenda does not. */
const loadEffect = (search: boolean) => ({
  agreements: executeAgreements({}, 'ops-agenda.agreements'),
  finance: readFinance('ops-agenda.finance'),
  occupancy: executeOccupancy({}, 'ops-agenda.occupancy'),
  ops: executeOverview(search ? { includeSearch: true } : {}, 'ops-agenda.overview').pipe(
    Effect.retry({ schedule: Schedule.spaced('700 millis'), times: 2, while: transientOverviewFailure }),
  ),
  parties: listCustomers({ includeArchived: false }),
  property: executeProperty({}, 'ops-agenda.property'),
  sales: loadSalesCases('ops-agenda.sales'),
  work: executeWork({}, 'ops-agenda.work'),
});
type Loaders = ReturnType<typeof loadEffect>;
type Success<Key extends keyof Loaders> = Effect.Success<Loaders[Key]>;

export type PropertyData = Success<'property'>;
export type AgreementsData = Success<'agreements'>;
export type OccupancyData = Success<'occupancy'>;
export type WorkData = Success<'work'>;
export type FinanceData = Success<'finance'>;
export type PartiesData = Success<'parties'>;
export type SalesData = Success<'sales'>;

export interface RentalOverviewSources {
  /** Provoz agendas, already reduced on the server to what these pages show (overview read). */
  readonly ops: SourceState<OverviewResponse>;
  readonly property: SourceState<PropertyData>;
  readonly agreements: SourceState<AgreementsData>;
  readonly occupancy: SourceState<OccupancyData>;
  readonly work: SourceState<WorkData>;
  readonly finance: SourceState<FinanceData>;
  readonly parties: SourceState<PartiesData>;
  /** Open sales cases (sales pipeline). Only the overview tile reads it; the calendar and search do not. */
  readonly sales: SourceState<SalesData>;
}

export type SourceKey = keyof RentalOverviewSources;
export const sourceKeys: readonly SourceKey[] = ['property', 'occupancy', 'agreements', 'work', 'finance', 'ops', 'parties'];

const loading = { status: 'loading' } as const;
const initial: RentalOverviewSources = {
  agreements: loading,
  finance: loading,
  occupancy: loading,
  ops: loading,
  parties: loading,
  property: loading,
  sales: loading,
  work: loading,
};

const failureStatus = (error: unknown): SourceStatus => {
  const tag = typeof error === 'object' && error !== null && '_tag' in error ? String(error._tag) : '';
  return /Forbidden|Authentication|Unauthorized/u.test(tag) ? 'forbidden' : 'unavailable';
};

const settle = <A, E>(effect: Effect.Effect<A, E>): Promise<SourceState<A>> =>
  browserRuntime.runPromise(
    effect.pipe(
      Effect.timeout('12 seconds'),
      Effect.match({
        onFailure: (error): SourceState<A> => ({ status: failureStatus(error) }),
        onSuccess: (data): SourceState<A> => ({ data, loadedAt: new Date().toISOString(), status: 'ready' }),
      }),
    ),
  );

/** Loads all sources in parallel; each settles independently so a slow or forbidden one never blocks the rest. */
export const useRentalOverviewSources = ({ search }: { readonly search: boolean }) => {
  const [sources, setSources] = useState<RentalOverviewSources>(initial);
  const ticket = useRef(0);

  const reload = useCallback(async () => {
    ticket.current += 1;
    const mine = ticket.current;
    const update = <Key extends SourceKey>(key: Key, value: RentalOverviewSources[Key]) => {
      if (mine === ticket.current) {
        setSources((current) => ({ ...current, [key]: value }));
      }
    };
    const loaders = loadEffect(search);
    await Promise.all([
      settle(loaders.ops).then((value) => update('ops', value)),
      settle(loaders.property).then((value) => update('property', value)),
      settle(loaders.agreements).then((value) => update('agreements', value)),
      settle(loaders.occupancy).then((value) => update('occupancy', value)),
      settle(loaders.work).then((value) => update('work', value)),
      settle(loaders.finance).then((value) => update('finance', value)),
      settle(loaders.parties).then((value) => update('parties', value)),
      settle(loaders.sales).then((value) => update('sales', value)),
    ]);
  }, [search]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const names = useMemo(() => nameLookup(sources), [sources]);
  return { names, reload, sources };
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

/** `true` once no source is still loading. */
export const allSettled = (sources: RentalOverviewSources) => sourceKeys.every((key) => sources[key].status !== 'loading');
