import { executeRecords as executeFinanceRecords } from '@app/finance-billing/clients/records';
import { executeRecords as executeWorkRecords } from '@app/work-tasks/clients/records';
import { definePageData, pageDataPending } from '@app/shared-contracts/page-data';
import type { PageDataSnapshot } from '@app/shared-contracts/page-data';
import { Data, Effect, Option, Result, Schema } from 'effect';
import { useEffect, useEffectEvent, useSyncExternalStore } from 'react';
import type { Occupancy } from '../../../../shared/apis/records.ts';
import { browserRuntime } from '../../../runtime/browser-effect-runtime.ts';
import { leaseRecords } from './lease-occupant.ts';
import type { LeaseDetailInput, LeaseInput } from './lease-occupant.ts';
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

class LeaseRelatedScopeMismatch extends Data.TaggedError('LeaseRelatedScopeMismatch') {}
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
    return yield* new LeaseRelatedScopeMismatch();
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

/**
 * The public Finance read cannot filter by occupancy/unit or page invoices. Preserve the existing foreground
 * capability, sharing that broad read once per full scope, never once per speculative row. Neither visible-row
 * warming nor the Shell preload calls this store. Bounded lease-invoice prewarming remains an owner API gap.
 */
export const leaseInvoices = definePageData({
  cancelWhenUnused: true,
  key: (input: LeaseInput) => keyOf([input.scope, 'finance.billing']),
  load: () =>
    executeFinanceRecords({}, 'property-leasing.lease-invoices').pipe(
      Effect.map((response): LeaseInvoiceRecords => ({
        invoices: response.state.invoices,
        revision: response.revision,
      })),
    ),
  maxEntries: 8,
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

/** Called serially after each occupant read inside the existing two-row, cancellable background batch. */
export const preloadLeaseRelated = (input: LeaseDetailInput): Effect.Effect<void> =>
  Effect.suspend(() => {
    const source = leaseRecords.snapshot(input);
    return input.reusable &&
      sameTenant(input) &&
      source.state === 'ready' &&
      !source.refreshing &&
      source.value.records.revision === input.revision &&
      source.value.records.occupancies.includes(input.record)
      ? leaseTasks.read(input).pipe(Effect.ignore)
      : Effect.void;
  });

export const invalidateLeaseRelated = (): void => {
  leaseTasks.invalidate();
  leaseInvoices.invalidate();
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
        invoices: Option.map(section(invoices), (value) =>
          value === 'unavailable' ? value : invoicesForLease(input.record, value.invoices),
        ),
        tasks: Option.map(section(tasks), (value) => (value === 'unavailable' ? value : value.items)),
      };

/** Warm task data is consumed in render. Foreground reads join inflight work and bypass unrelated row slots. */
export const useLeaseRelated = (input: LeaseDetailInput | undefined): LeaseRelated => {
  const tasks = useSyncExternalStore(
    (listener) => leaseTasks.subscribe(listener, input),
    () => (input === undefined ? pageDataPending : leaseTasks.snapshot(input)),
    () => pageDataPending,
  );
  const invoices = useSyncExternalStore(
    (listener) => leaseInvoices.subscribe(listener, input),
    () => (input === undefined ? pageDataPending : leaseInvoices.snapshot(input)),
    () => pageDataPending,
  );
  const taskRequest = input === undefined ? '' : leaseTaskKey(input);
  const invoiceRequest = input === undefined ? '' : leaseInvoices.key(input);
  const readTasks = useEffectEvent(() =>
    input === undefined ? Effect.void : leaseTasks.read(input).pipe(Effect.ignore),
  );
  const readInvoices = useEffectEvent(() =>
    input === undefined ? Effect.void : leaseInvoices.read(input).pipe(Effect.ignore),
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
