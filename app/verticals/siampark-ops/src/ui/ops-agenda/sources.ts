// @effect-diagnostics asyncFunction:off globalDate:off
// Loads every Siampark source the calendar / overview / search read, each through its owner's PUBLIC governed read
// (own gateway audience, own permission check). A source the person may not read, or that is down, is reported
// per source ("bez oprávnění" / "zdroj nedostupný") and never replaced by zeros. Owned by the ops-agenda lane.
import { listCustomers } from '@app/party-registry/api/client';
import { executeRecords as executeAgreements } from '@app/siampark-agreements/clients/records';
import { executeRecords as executeFinance } from '@app/siampark-billing-finance/clients/records';
import { executeRecords as executeOccupancy } from '@app/siampark-occupancy/clients/records';
import { executeRecords as executeProperty } from '@app/siampark-property/clients/records';
import { executeRecords as executeWork } from '@app/siampark-work/clients/records';
import { Effect } from 'effect';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RecordsResponse as OpsRecords } from '../../../shared/apis/records.ts';
import { agendaIds } from '../../../shared/agendas.ts';
import { browserRuntime } from '../../runtime/browser-effect-runtime.ts';
import { loadRecords } from '../use-agenda.ts';

export type SourceStatus = 'loading' | 'ready' | 'forbidden' | 'unavailable';

export interface SourceState<Data> {
  readonly status: SourceStatus;
  readonly data?: Data;
  /** ISO timestamp of the successful read. */
  readonly loadedAt?: string;
}

const loadEffect = () => ({
  agreements: executeAgreements({}, 'ops-agenda.agreements'),
  finance: executeFinance({}, 'ops-agenda.finance'),
  occupancy: executeOccupancy({}, 'ops-agenda.occupancy'),
  parties: listCustomers({ includeArchived: false }),
  property: executeProperty({}, 'ops-agenda.property'),
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

export interface SiamparkSources {
  readonly ops: SourceState<OpsRecords>;
  readonly property: SourceState<PropertyData>;
  readonly agreements: SourceState<AgreementsData>;
  readonly occupancy: SourceState<OccupancyData>;
  readonly work: SourceState<WorkData>;
  readonly finance: SourceState<FinanceData>;
  readonly parties: SourceState<PartiesData>;
}

export type SourceKey = keyof SiamparkSources;
export const sourceKeys: readonly SourceKey[] = ['property', 'occupancy', 'agreements', 'work', 'finance', 'ops', 'parties'];

const loading = { status: 'loading' } as const;
const initial: SiamparkSources = {
  agreements: loading,
  finance: loading,
  occupancy: loading,
  ops: loading,
  parties: loading,
  property: loading,
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
export const useSiamparkSources = () => {
  const [sources, setSources] = useState<SiamparkSources>(initial);
  const ticket = useRef(0);

  const reload = useCallback(async () => {
    ticket.current += 1;
    const mine = ticket.current;
    const update = <Key extends SourceKey>(key: Key, value: SiamparkSources[Key]) => {
      if (mine === ticket.current) {
        setSources((current) => ({ ...current, [key]: value }));
      }
    };
    const loaders = loadEffect();
    await Promise.all([
      loadRecords({ agendas: agendaIds }).then((outcome) =>
        update(
          'ops',
          outcome.ok
            ? { data: outcome.data, loadedAt: new Date().toISOString(), status: 'ready' }
            : { status: outcome.reason === 'forbidden' ? 'forbidden' : 'unavailable' },
        ),
      ),
      settle(loaders.property).then((value) => update('property', value)),
      settle(loaders.agreements).then((value) => update('agreements', value)),
      settle(loaders.occupancy).then((value) => update('occupancy', value)),
      settle(loaders.work).then((value) => update('work', value)),
      settle(loaders.finance).then((value) => update('finance', value)),
      settle(loaders.parties).then((value) => update('parties', value)),
    ]);
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const names = useMemo(() => nameLookup(sources), [sources]);
  return { names, reload, sources };
};

/** Display names of properties, units (`Budova › Jednotka`) and counterparties, keyed by resource id. */
export const nameLookup = (sources: SiamparkSources): ReadonlyMap<string, string> => {
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
export const allSettled = (sources: SiamparkSources) => sourceKeys.every((key) => sources[key].status !== 'loading');
