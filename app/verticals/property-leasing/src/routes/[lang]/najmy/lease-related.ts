import { LEASE_INVOICES_PAGE_LIMIT_MAX, executeLeaseInvoices } from '@app/finance-billing/clients/lease-invoices';
import { executeRecords as executeWorkRecords } from '@app/work-tasks/clients/records';
import { definePageData, pageDataPending } from '@app/shared-contracts/page-data';
import type { PageDataSnapshot } from '@app/shared-contracts/page-data';
import { Data, Effect, Option, Result, Schema } from 'effect';
import { useEffect, useEffectEvent, useSyncExternalStore } from 'react';
import type { Occupancy } from '../../../../shared/apis/records.ts';
import { browserRuntime } from '../../../runtime/browser-effect-runtime.ts';
import { leaseRecords } from './lease-occupant.ts';
import type { LeaseDetailInput } from './lease-occupant.ts';
import type { LeaseInvoice, LeaseRelated, LeaseTask } from './lease-story.tsx';

const KeySchema = Schema.fromJsonString(Schema.Array(Schema.String));
const keyOf = (parts: readonly string[]) => Result.getOrThrow(Schema.encodeResult(KeySchema)(parts));
interface ResourceRef {
  readonly moduleId: string;
  readonly resourceId: string;
  readonly resourceType: string;
  readonly tenantId: string;
}
const sameRef = (left: ResourceRef | undefined, right: ResourceRef | null): boolean =>
  left !== undefined &&
  right !== null &&
  left.moduleId === right.moduleId &&
  left.tenantId === right.tenantId &&
  left.resourceType === right.resourceType &&
  left.resourceId === right.resourceId;

export interface LeaseTaskRecords {
  readonly items: readonly LeaseTask[];
  /** Work Tasks' actual response revision, independent of the lease aggregate revision in the key. */
  readonly revision: number;
}

/** One typed failure family for the related reads: foreign scope, revision drift and a stalled page cursor. */
class LeaseRelatedFailure extends Data.TaggedError('LeaseRelatedFailure')<{
  readonly kind: 'cursor-stalled' | 'revision-changed' | 'scope-mismatch';
  readonly reason: string;
}> {}
const sameTenant = (input: LeaseDetailInput): boolean =>
  input.record.occupancyRef.tenantId === input.tenantId && input.record.unitRef.tenantId === input.tenantId;

/** Leases of the same unit share the exact same governed task query, not a company-wide task list. */
export const leaseTaskKey = (input: LeaseDetailInput): string =>
  keyOf([
    input.scope,
    'work.tasks',
    input.record.unitRef.moduleId,
    input.record.unitRef.resourceType,
    input.record.unitRef.tenantId,
    input.record.unitRef.resourceId,
    String(input.revision),
  ]);

const loadLeaseTasks = Effect.fn('LeaseRelated.loadTasks')(function* loadLeaseTasks(input: LeaseDetailInput) {
  if (input.reusable && !sameTenant(input)) {
    return yield* new LeaseRelatedFailure({
      kind: 'scope-mismatch',
      reason: 'The lease references are outside the selected tenant',
    });
  }
  const response = yield* executeWorkRecords(
    { contextResourceId: input.record.unitRef.resourceId },
    'property-leasing.unit-tasks',
  );
  return {
    items: response.items.filter((task) => task.contextRefs.some((ref) => sameRef(ref, input.record.unitRef))),
    revision: response.revision,
  } satisfies LeaseTaskRecords;
});
export const leaseTasks = definePageData({
  cancelWhenUnused: true,
  key: leaseTaskKey,
  load: loadLeaseTasks,
  maxEntries: 256,
  retainStale: false,
  runtime: browserRuntime,
});

export interface LeaseInvoiceRecords {
  readonly invoices: readonly LeaseInvoice[];
  readonly revision: number;
}

const leaseInvoiceCorrelation = 'property-leasing.lease-invoices';

/** Key: full scope, exact occupancy/unit/Counterparty refs, and the lease revision that seeded the prewarm. */
export const leaseInvoiceExactKey = (input: LeaseDetailInput): string =>
  keyOf([
    input.scope,
    'finance.billing.lease-invoices',
    input.record.occupancyRef.moduleId,
    input.record.occupancyRef.resourceType,
    input.record.occupancyRef.tenantId,
    input.record.occupancyRef.resourceId,
    input.record.unitRef.moduleId,
    input.record.unitRef.resourceType,
    input.record.unitRef.tenantId,
    input.record.unitRef.resourceId,
    input.record.customerCounterpartyRef?.tenantId ?? '',
    input.record.customerCounterpartyRef?.resourceId ?? '',
    String(input.revision),
  ]);

const leaseInvoiceRequest = (input: LeaseDetailInput) => {
  const { customerCounterpartyRef } = input.record;
  const request = {
    limit: LEASE_INVOICES_PAGE_LIMIT_MAX,
    occupancyRef: input.record.occupancyRef,
    unitRef: input.record.unitRef,
  };
  return customerCounterpartyRef === null ? request : { ...request, counterpartyRef: customerCounterpartyRef };
};

type LeaseInvoicePageFailure = LeaseRelatedFailure | Effect.Error<ReturnType<typeof executeLeaseInvoices>>;

/**
 * Consumes every page of the exact lease read. Each page must keep the first page's Finance revision, the cursor
 * must advance to a never-seen position, and only an absent `nextCursor` completes the collection — a revision
 * change or a stalled cursor fails honestly instead of retrying or claiming completeness. Interruption (page
 * close, selection change) cancels the in-flight page and leaves no settled value.
 */
const loadLeaseInvoicesExact = Effect.fn('LeaseRelated.loadInvoicesExact')(function* loadLeaseInvoicesExact(
  input: LeaseDetailInput,
) {
  if (input.reusable && !sameTenant(input)) {
    return yield* new LeaseRelatedFailure({
      kind: 'scope-mismatch',
      reason: 'The lease references are outside the selected tenant',
    });
  }
  const request = leaseInvoiceRequest(input);
  const first = yield* executeLeaseInvoices(request, leaseInvoiceCorrelation);
  const loadPage: (
    invoices: readonly LeaseInvoice[],
    revision: number,
    cursor: string,
    seenCursors: ReadonlySet<string>,
  ) => Effect.Effect<LeaseInvoiceRecords, LeaseInvoicePageFailure> = Effect.fn('LeaseRelated.loadInvoicePage')(
    function* loadLeaseInvoicePage(invoices, revision, cursor, seenCursors) {
      if (seenCursors.has(cursor)) {
        return yield* new LeaseRelatedFailure({
          kind: 'cursor-stalled',
          reason: 'The Finance lease-invoice page cursor did not advance',
        });
      }
      const page = yield* executeLeaseInvoices({ ...request, cursor }, leaseInvoiceCorrelation);
      if (page.revision !== revision) {
        return yield* new LeaseRelatedFailure({
          kind: 'revision-changed',
          reason: 'The Finance revision changed between lease-invoice pages',
        });
      }
      if (page.nextCursor !== undefined && (page.nextCursor === cursor || seenCursors.has(page.nextCursor))) {
        return yield* new LeaseRelatedFailure({
          kind: 'cursor-stalled',
          reason: 'The Finance lease-invoice page cursor did not advance',
        });
      }
      const collected = [...invoices, ...page.invoices];
      return page.nextCursor === undefined
        ? { invoices: collected, revision }
        : yield* loadPage(collected, revision, page.nextCursor, new Set([...seenCursors, cursor]));
    },
  );
  return first.nextCursor === undefined
    ? { invoices: first.invoices, revision: first.revision }
    : yield* loadPage(first.invoices, first.revision, first.nextCursor, new Set());
});

/** Bounded exact lease-invoice prewarm: complete pages of one exact request, cancellable, never a partial claim. */
export const leaseInvoicesExact = definePageData({
  cancelWhenUnused: true,
  key: leaseInvoiceExactKey,
  load: loadLeaseInvoicesExact,
  maxEntries: 256,
  retainStale: false,
  runtime: browserRuntime,
});

/** Match only public owner references. An occupancy-linked invoice is never guessed from its payer or property. */
export const invoicesForLease = (record: Occupancy, invoices: readonly LeaseInvoice[]): readonly LeaseInvoice[] =>
  invoices.filter(
    (invoice) =>
      sameRef(invoice.occupancyRef, record.occupancyRef) ||
      (invoice.occupancyRef === undefined &&
        sameRef(invoice.unitRef, record.unitRef) &&
        sameRef(invoice.counterpartyRef, record.customerCounterpartyRef)),
  );

/**
 * Called serially after each occupant read inside the existing two-row, cancellable background batch: the unit
 * task read first, then the exact paginated lease-invoice read for the same validated row.
 */
export const preloadLeaseRelated = (input: LeaseDetailInput): Effect.Effect<void> =>
  Effect.suspend(() => {
    const source = leaseRecords.snapshot(input);
    return input.reusable &&
      sameTenant(input) &&
      source.state === 'ready' &&
      !source.refreshing &&
      source.value.records.revision === input.revision &&
      source.value.records.occupancies.includes(input.record)
      ? leaseTasks.read(input).pipe(Effect.ignore, Effect.andThen(leaseInvoicesExact.read(input)), Effect.ignore)
      : Effect.void;
  });

export const invalidateLeaseRelated = (): void => {
  leaseTasks.invalidate();
  leaseInvoicesExact.invalidate();
};

const section = <Value, Failure>(snapshot: PageDataSnapshot<Value, Failure>): Option.Option<Value | 'unavailable'> => {
  if (snapshot.state === 'pending') {
    return Option.none();
  }
  return snapshot.state === 'failed' ? Option.some('unavailable') : Option.some(snapshot.value);
};

export const leaseRelatedView = (
  input: LeaseDetailInput | undefined,
  tasks: PageDataSnapshot<LeaseTaskRecords, unknown>,
  invoices: PageDataSnapshot<LeaseInvoiceRecords, unknown>,
): LeaseRelated =>
  input === undefined
    ? { invoices: Option.none(), tasks: Option.none() }
    : {
        // The exact paginated lease read is the only invoice source: pending renders loading, a denial or an
        // incomplete/drifted collection renders `unavailable`, and a ready snapshot is the settled exact rows.
        invoices: Option.map(section(invoices), (value) =>
          value === 'unavailable' ? value : invoicesForLease(input.record, value.invoices),
        ),
        tasks: Option.map(section(tasks), (value) => (value === 'unavailable' ? value : value.items)),
      };

/**
 * Warm related data is consumed in render. The exact lease read is the only invoice source; the broad company
 * ledger read is never started here. Foreground reads join inflight work and bypass unrelated row slots.
 */
export const useLeaseRelated = (input: LeaseDetailInput | undefined): LeaseRelated => {
  const tasks = useSyncExternalStore(
    (listener) => leaseTasks.subscribe(listener, input),
    () => (input === undefined ? pageDataPending : leaseTasks.snapshot(input)),
    () => pageDataPending,
  );
  const invoices = useSyncExternalStore(
    (listener) => leaseInvoicesExact.subscribe(listener, input),
    () => (input === undefined ? pageDataPending : leaseInvoicesExact.snapshot(input)),
    () => pageDataPending,
  );
  const taskRequest = input === undefined ? '' : leaseTaskKey(input);
  const invoiceRequest = input === undefined ? '' : leaseInvoiceExactKey(input);
  const readTasks = useEffectEvent(() =>
    input === undefined ? Effect.void : leaseTasks.read(input).pipe(Effect.ignore),
  );
  const readInvoices = useEffectEvent(() =>
    input === undefined ? Effect.void : leaseInvoicesExact.read(input).pipe(Effect.ignore),
  );
  useEffect(() => {
    const fiber = taskRequest === '' ? undefined : browserRuntime.runFork(readTasks());
    return () => fiber?.interruptUnsafe();
  }, [taskRequest]);
  useEffect(() => {
    const fiber = invoiceRequest === '' ? undefined : browserRuntime.runFork(readInvoices());
    return () => fiber?.interruptUnsafe();
  }, [invoiceRequest]);
  return leaseRelatedView(input, tasks, invoices);
};
