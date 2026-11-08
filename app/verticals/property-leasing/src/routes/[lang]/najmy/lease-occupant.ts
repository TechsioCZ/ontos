import {
  definePageData,
  modulePagePreload,
  pageDataPending,
  pageDataScopeKey,
  moduleWriteEvent,
  moduleChangeEvent,
} from '@app/shared-contracts/page-data';
import type { ModulePageProps } from '@app/shared-contracts/page-data';
import { executeCounterpartyRead, executePartyDetail, listCustomers } from '@app/party-registry/api/client';
import { executeRecords as executePropertyRecords } from '@app/property-portfolio/clients/records';
import { executeRecords as executeAgreementsRecords } from '@app/legal-agreements/clients/records';
import { Effect, Option, Result, Schema } from 'effect';
import { constVoid } from 'effect/Function';
import { useEffect, useEffectEvent, useSyncExternalStore } from 'react';
import type { Occupancy } from '../../../../shared/apis/records.ts';
import { decodeRecordsSearch } from '../../../../shared/domain/records-search.ts';
import type { RecordsSearch } from '../../../../shared/domain/records-search.ts';
import type { TenantDirectoryEntry } from './lease-story.tsx';
import { executeRecords } from '../../../api/records-client.ts';
import { browserRuntime } from '../../../runtime/browser-effect-runtime.ts';

const keyOf = (parts: readonly string[]) =>
  Result.getOrThrow(Schema.encodeResult(Schema.fromJsonString(Schema.Array(Schema.String)))(parts));
const moduleId = 'property.leasing';

export interface LeaseInput {
  readonly legalEntityId: string;
  readonly principalId: string;
  readonly reusable: boolean;
  readonly scope: string;
  readonly tenantId: string;
}
export interface LeaseDetailInput extends LeaseInput {
  readonly record: Occupancy;
  readonly revision: number;
}
export const leaseInputOf = (context?: ModulePageProps['context'], standaloneScope = ''): LeaseInput => ({
  legalEntityId: context?.legalEntityId ?? '',
  principalId: context?.principalId ?? '',
  reusable: pageDataScopeKey(context, moduleId) !== undefined,
  scope:
    pageDataScopeKey(context, moduleId) ??
    keyOf([
      moduleId,
      'standalone',
      standaloneScope,
      context?.tenantId ?? '',
      context?.legalEntityId ?? '',
      context?.principalId ?? '',
    ]),
  tenantId: context?.tenantId ?? '',
});

export const loadOccupantName = Effect.fn('Occupancy.loadOccupantName')(function* resolveOccupantName(
  record: Occupancy | undefined,
) {
  if (record === undefined) {
    return Option.none<string>();
  }
  if (record.customerCounterpartyRef !== null) {
    const customer = yield* executeCounterpartyRead(
      { counterpartyRef: record.customerCounterpartyRef },
      'property-leasing.customer-detail',
    );
    return Option.fromNullishOr(customer.party.displayName);
  }
  if (record.guestPartyRef !== null) {
    const guest = yield* executePartyDetail({ partyRef: record.guestPartyRef }, 'property-leasing.guest-detail');
    // The name is absent when the reader lacks the Party identity field; no name is shown then, never a fallback.
    return guest.party.displayName ?? Option.none<string>();
  }
  return Option.none<string>();
});
export const loadLeaseRecords = Effect.fn('PropertyLeasing.loadLeaseRecords')(function* loadLeaseRecordsData() {
  const { agreements, directory, properties, records } = yield* Effect.all(
    {
      agreements: executeAgreementsRecords({}, 'property-leasing.contracts'),
      // The tenant column and card are optional: a role without the customer list still sees its leases.
      directory: listCustomers({ includeArchived: true, limit: 500 }).pipe(Effect.option),
      properties: executePropertyRecords({}, 'property-leasing.units'),
      records: executeRecords({}, 'property-leasing.records'),
    },
    { concurrency: 4 },
  );
  const tenantDirectory: readonly TenantDirectoryEntry[] = Option.getOrElse(directory, () => []);
  return { agreements, properties, records, tenantDirectory };
});

/** Base records settle without a whole-register burst of guest identity reads. */
export const leaseRecords = definePageData({
  key: (input: LeaseInput) => input.scope,
  load: () => loadLeaseRecords(),
  maxEntries: 8,
  retainStale: false,
  runtime: browserRuntime,
});
export const occupantKey = (input: LeaseDetailInput) =>
  keyOf([
    input.scope,
    input.record.occupancyRef.tenantId,
    input.record.occupancyRef.resourceId,
    String(input.revision),
    input.record.customerCounterpartyRef?.tenantId ?? '',
    input.record.customerCounterpartyRef?.resourceId ?? '',
    input.record.guestPartyRef?.tenantId ?? '',
    input.record.guestPartyRef?.resourceId ?? '',
  ]);
/** A failed related-owner read is not retained as a reusable authorization decision. */
export const leaseOccupant = definePageData({
  cancelWhenUnused: true,
  key: occupantKey,
  load: (input: LeaseDetailInput) => loadOccupantName(input.record).pipe(Effect.map(Option.getOrUndefined)),
  maxEntries: 256,
  retainStale: false,
  runtime: browserRuntime,
});
const occupantInputs = (
  input: LeaseInput,
  rows: readonly Occupancy[],
  revision: number,
): readonly LeaseDetailInput[] =>
  input.reusable
    ? rows
        .slice(0, 200)
        .flatMap((record) => (record.occupancyRef.tenantId === input.tenantId ? [{ ...input, record, revision }] : []))
    : [];
type RelatedPreload = (input: LeaseDetailInput) => Effect.Effect<void>;
const preloadInputs = (inputs: readonly LeaseDetailInput[], related?: RelatedPreload) =>
  Effect.forEach(
    inputs,
    (input) =>
      leaseOccupant.read(input).pipe(
        Effect.ignore,
        Effect.andThen(() => (related === undefined ? Effect.void : related(input))),
      ),
    { concurrency: 2, discard: true },
  );
export const preloadLeaseOccupants = (
  input: LeaseInput,
  rows: readonly Occupancy[],
  revision: number,
  related?: RelatedPreload,
) => preloadInputs(occupantInputs(input, rows, revision), related);
/** The list is not rendered on a lease or counterparty detail URL. */
export const renderedLeaseOccupantRows = (
  resourceId: string | undefined,
  counterpartyId: string | undefined,
  visible: readonly Occupancy[],
) => (resourceId === undefined && counterpartyId === undefined ? visible : []);
/** The plain Table has no hidden sort/page model; these are its exact filtered rows. */
export const usePrefetchLeaseOccupants = (
  input: LeaseInput,
  rows: readonly Occupancy[],
  revision: number,
  related?: RelatedPreload,
) => {
  const selection = keyOf(occupantInputs(input, rows, revision).map(occupantKey));
  const { scope } = input;
  const source = leaseRecords.snapshot(input);
  const preload = useEffectEvent((currentScope: string) => {
    const current = leaseRecords.snapshot({ ...input, scope: currentScope });
    return current.state === 'ready' &&
      !current.refreshing &&
      current.value.records.revision === revision &&
      rows.every((row) => current.value.records.occupancies.includes(row))
      ? preloadLeaseOccupants({ ...input, scope: currentScope }, rows, revision, related)
      : Effect.void;
  });
  useEffect(() => {
    if (selection === '[]' || source.state !== 'ready' || source.refreshing) {
      return constVoid;
    }
    let fiber = browserRuntime.runFork(preload(scope));
    const restart = () => {
      fiber.interruptUnsafe();
      fiber = browserRuntime.runFork(preload(scope));
    };
    globalThis.addEventListener(moduleWriteEvent, restart);
    globalThis.addEventListener(moduleChangeEvent, restart);
    return () => {
      globalThis.removeEventListener(moduleWriteEvent, restart);
      globalThis.removeEventListener(moduleChangeEvent, restart);
      fiber.interruptUnsafe();
    };
  }, [scope, selection, source]);
  useSyncExternalStore(
    leaseOccupant.subscribe,
    () =>
      keyOf(
        rows.slice(0, 200).map((record) => {
          const snapshot = leaseOccupant.snapshot({ ...input, record, revision });
          return snapshot.state === 'ready' ? keyOf(['ready', snapshot.value ?? '']) : snapshot.state;
        }),
      ),
    () => '[]',
  );
  return (record: Occupancy) => {
    const snapshot = leaseOccupant.snapshot({ ...input, record, revision });
    return snapshot.state === 'ready' ? snapshot.value : undefined;
  };
};
export const prepareLeasePage = (props: ModulePageProps, related?: RelatedPreload): Effect.Effect<void> => {
  const input = leaseInputOf(props.context);
  if (!input.reusable) {
    return Effect.void;
  }
  return leaseRecords.read(input).pipe(
    Effect.flatMap((current) => {
      const resourceId = Option.getOrUndefined(decodeRecordsSearch(props.search))?.resourceId;
      const record = current.records.occupancies.find((row) => row.occupancyRef.resourceId === resourceId);
      return record === undefined
        ? Effect.void
        : preloadInputs([{ ...input, record, revision: current.records.revision }], related);
    }),
    Effect.ignore,
  );
};
export const preloadPage = modulePagePreload(prepareLeasePage);
/** Foreground uses the exact authorized base row/revision and joins a visible-row read. */
export const useLeaseData = (input: LeaseInput, search: Option.Option<RecordsSearch>) => {
  const resourceId = Option.getOrUndefined(search)?.resourceId;
  const records = useSyncExternalStore(
    (listener) => leaseRecords.subscribe(listener, input),
    () => leaseRecords.snapshot(input),
    () => pageDataPending,
  );
  const current = records.state === 'ready' ? records.value.records : undefined;
  const record = current?.occupancies.find((row) => row.occupancyRef.resourceId === resourceId);
  const detailInput: LeaseDetailInput | undefined =
    record === undefined || current === undefined ? undefined : { ...input, record, revision: current.revision };
  const occupant = useSyncExternalStore(
    (listener) => leaseOccupant.subscribe(listener, detailInput),
    () => (detailInput === undefined ? pageDataPending : leaseOccupant.snapshot(detailInput)),
    () => pageDataPending,
  );
  const { scope } = input;
  const ensure = useEffectEvent((currentScope: string) => leaseRecords.ensure({ ...input, scope: currentScope }));
  useEffect(() => {
    ensure(scope);
  }, [scope]);
  const revision = current?.revision ?? 0;
  const read = useEffectEvent((currentScope: string, currentRecord: Occupancy, currentRevision: number) =>
    leaseOccupant
      .read({ ...input, record: currentRecord, revision: currentRevision, scope: currentScope })
      .pipe(Effect.ignore),
  );
  useEffect(() => {
    const fiber = record === undefined ? undefined : browserRuntime.runFork(read(scope, record, revision));
    return () => fiber?.interruptUnsafe();
  }, [scope, record, revision]);
  return { detailInput, leaseInput: input, occupant, records };
};
