import { Deferred, Effect, Fiber, Match, Option, Result, Schema } from 'effect';
import { afterAll, beforeAll, beforeEach, expect, it, rstest } from 'effect-rstest';
import { createElement } from 'react';
import type ReactRuntime from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { moduleChangeEvent, moduleWriteEvent, pageDataScopeKey } from '@app/shared-contracts/page-data';
import { RecordsResponseSchema } from '../../shared/apis/records.ts';
import {
  agreementCustomerData,
  agreements,
  agreementsInputOf,
  preloadAgreementCustomers,
  preloadPage,
  useAgreementCustomer,
} from '../../src/routes/[lang]/smlouvy/agreements-data.ts';

const mocks = rstest.hoisted(() => ({ customer: rstest.fn(), customers: rstest.fn(), records: rstest.fn() }));
rstest.mock('@app/party-registry/api/client', () => ({
  executeCounterpartyRead: mocks.customer,
  listCustomers: mocks.customers,
}));
rstest.mock('../../src/api/records-client.ts', () => ({ executeRecords: mocks.records }));
rstest.mock('../../src/routes/[lang]/smlouvy/rental-reference-access.ts', () => ({
  rentalReferenceAccess: Effect.succeed(false),
}));
rstest.mock('react', () => ({
  ...rstest.requireActual<typeof ReactRuntime>('react'),
  useSyncExternalStore: <Value>(_subscribe: (listener: () => void) => () => void, snapshot: () => Value) => snapshot(),
}));
const events = new EventTarget();
const globals = {
  addEventListener: events.addEventListener.bind(events),
  dispatchEvent: events.dispatchEvent.bind(events),
  document: {},
  removeEventListener: events.removeEventListener.bind(events),
};
beforeAll(() => {
  for (const [key, value] of Object.entries(globals)) {
    Reflect.set(globalThis, key, value);
  }
});
afterAll(() => {
  for (const key of Object.keys(globals)) {
    Reflect.deleteProperty(globalThis, key);
  }
});
const context = { legalEntityId: 'company-a', principalId: 'principal-a', tenantId: 'tenant-a' };
const scope = pageDataScopeKey(context, 'legal.agreements') ?? '';
const id = '10000000-0000-4000-8000-000000000001';
const otherId = '10000000-0000-4000-8000-000000000002';
const ref = {
  moduleId: 'legal.agreements' as const,
  resourceType: 'legal.agreements.contract' as const,
  tenantId: '10000000-0000-4000-8000-000000000003',
};
const records = Schema.decodeSync(RecordsResponseSchema)({
  contracts: [id, otherId].map((resourceId) => ({
    contractRef: { ...ref, resourceId },
    counterpartyRef: {
      moduleId: 'party.registry',
      resourceId,
      resourceType: 'party.registry.counterparty',
      tenantId: ref.tenantId,
    },
    endDate: null,
    expiringSoon: false,
    hasSuccessorDraft: false,
    isExpired: false,
    kind: 'OTHER',
    lifecycleState: 'ACTIVE',
    note: null,
    occupancyRef: null,
    propertyRef: null,
    renewalNoticeDate: null,
    signatureState: 'NOT_SENT',
    startDate: '2026-11-03',
    subject: `Contract ${resourceId}`,
    supersedesContractRef: null,
    unitRef: null,
  })),
  documents: [],
  revision: 7,
});
const contract = Option.getOrThrow(Option.fromUndefinedOr(records.contracts[0]));
const input = { contract, revision: 7, scope };
const props = { context, routeParams: {}, search: `?resourceId=${id}` };
beforeEach(() => {
  rstest.resetAllMocks();
  agreements.invalidate();
  agreementCustomerData.invalidate();
  mocks.records.mockReturnValue(Effect.succeed(records));
  mocks.customers.mockReturnValue(Effect.succeed([]));
  mocks.customer.mockReturnValue(Effect.succeed({ party: { displayName: 'Authorized customer' } }));
});
const Detail = () => {
  const value = useAgreementCustomer(context, contract, 7);
  return createElement('p', null, value.customerName ?? value.customerNameFeedback);
};
it.effect('warms the real name and the first selected render makes no extra request', () =>
  Effect.gen(function* test() {
    yield* preloadAgreementCustomers(context, [contract], 7);
    expect(mocks.customer).toHaveBeenCalledTimes(1);
    expect(renderToStaticMarkup(createElement(Detail))).toContain('Authorized customer');
    yield* agreementCustomerData.read(input);
    expect(mocks.customer).toHaveBeenCalledTimes(1);
  }),
);
it.live('preloads the exact cold deep link, then another selection reuses base records without rereading them', () =>
  Effect.gen(function* test() {
    yield* Effect.promise(() => preloadPage(props));
    expect(mocks.records).toHaveBeenCalledTimes(1);
    expect(mocks.customer).toHaveBeenCalledTimes(1);
    expect(mocks.customer.mock.calls[0]?.[0]).toEqual({ counterpartyRef: contract.counterpartyRef });
    const selected = agreementCustomerData.snapshot(input);
    expect(selected.state).toBe('ready');
    const next = { ...props, search: `?resourceId=${otherId}` };
    yield* Effect.promise(() => preloadPage(next));
    expect(mocks.records).toHaveBeenCalledTimes(1);
    expect(mocks.customer).toHaveBeenCalledTimes(2);
    expect(agreements.key(agreementsInputOf(props, ''))).toBe(agreements.key(agreementsInputOf(next, '')));
  }),
);
it.live('never translates a missing or invalid contract identity into a customer lookup', () =>
  Effect.gen(function* test() {
    yield* Effect.promise(() => preloadPage({ ...props, search: '?resourceId=10000000-0000-4000-8000-000000000099' }));
    yield* Effect.promise(() => preloadPage({ ...props, search: '?resourceId=invalid' }));
    expect(mocks.customer).not.toHaveBeenCalled();
    expect(mocks.records).toHaveBeenCalledTimes(1);
  }),
);
it.effect('separates every scope field, revision, module and reference tenant', () =>
  Effect.gen(function* test() {
    yield* preloadAgreementCustomers(context, [contract], 7);
    for (const next of [
      { ...context, tenantId: 'other' },
      { ...context, principalId: 'other' },
      { ...context, legalEntityId: 'other' },
    ]) {
      yield* preloadAgreementCustomers(next, [contract], 7);
      expect(agreements.key({ context: next, legalEntityId: next.legalEntityId, resourceId: id })).not.toBe(
        agreements.key(agreementsInputOf(props, '')),
      );
    }
    yield* agreementCustomerData.read({ ...input, revision: 8 });
    yield* agreementCustomerData.read({ ...input, scope: pageDataScopeKey(context, 'other.module') ?? '' });
    yield* agreementCustomerData.read({
      ...input,
      contract: { ...contract, counterpartyRef: { ...contract.counterpartyRef, tenantId: 'other-tenant' } },
    });
    expect(mocks.customer).toHaveBeenCalledTimes(7);
  }),
);
it.effect('skips speculative reads without full identity and never caches a denied name as success', () =>
  Effect.gen(function* test() {
    yield* preloadAgreementCustomers(undefined, [contract], 7);
    yield* preloadAgreementCustomers({ ...context, tenantId: '' }, [contract], 7);
    expect(mocks.customer).not.toHaveBeenCalled();
    mocks.customer.mockReturnValue(Effect.fail({ _tag: 'CounterpartyReadForbiddenProblem', status: 403 }));
    yield* preloadAgreementCustomers(context, [contract], 7);
    expect(agreementCustomerData.snapshot(input).state).toBe('failed');
    mocks.customer.mockReturnValue(Effect.succeed({ party: { displayName: 'Now allowed' } }));
    expect(yield* agreementCustomerData.read(input)).toBe('Now allowed');
    expect(mocks.customer).toHaveBeenCalledTimes(2);
  }),
);
it.effect('preserves the base contract when name lookup fails and drops it after a primary denial', () =>
  Effect.gen(function* test() {
    const query = agreementsInputOf(props, '');
    yield* agreements.read(query);
    mocks.customer.mockReturnValue(Effect.fail({ _tag: 'CounterpartyReadUnavailableProblem' }));
    yield* preloadAgreementCustomers(context, [contract], 7);
    const base = agreements.snapshot(query);
    expect(base.state).toBe('ready');
    if (base.state === 'ready') {
      expect(Option.getOrUndefined(base.value)?.records.contracts[0]?.contractRef.resourceId).toBe(id);
    }
    mocks.records.mockReturnValue(Effect.fail({ _tag: 'RecordsForbiddenProblem', status: 403 }));
    yield* agreements.refresh(query);
    expect(agreements.snapshot(query).state).toBe('failed');
  }),
);
it.effect('starts at most two visible rows and aborts active/queued prefetch on page change', () =>
  Effect.gen(function* test() {
    const started = yield* Deferred.make<boolean>();
    let active = 0;
    let aborted = 0;
    mocks.customer.mockImplementation(() =>
      Effect.gen(function* blocked() {
        active += 1;
        if (active === 2) {
          yield* Deferred.succeed(started, true);
        }
        return yield* Effect.never;
      }).pipe(
        Effect.onInterrupt(() =>
          Effect.sync(() => {
            aborted += 1;
          }),
        ),
      ),
    );
    const third = { ...contract, contractRef: { ...contract.contractRef, resourceId: 'third' } };
    const fiber = yield* Effect.forkChild(preloadAgreementCustomers(context, [...records.contracts, third], 7));
    yield* Deferred.await(started);
    expect(active).toBe(2);
    yield* Fiber.interrupt(fiber);
    expect(aborted).toBe(2);
    expect(mocks.customer).toHaveBeenCalledTimes(2);
  }),
);
it.effect('never returns an old name after live invalidation, including a newly denied owner read', () =>
  Effect.gen(function* test() {
    yield* preloadAgreementCustomers(context, [contract], 7);
    events.dispatchEvent(new Event(moduleChangeEvent));
    expect(agreementCustomerData.snapshot(input).state).toBe('pending');
    mocks.customer.mockReturnValue(Effect.fail({ _tag: 'CounterpartyReadForbiddenProblem', status: 403 }));
    yield* agreementCustomerData.read(input).pipe(Effect.ignore);
    expect(agreementCustomerData.snapshot(input).state).toBe('failed');
    expect(renderToStaticMarkup(createElement(Detail))).not.toContain('Authorized customer');
    events.dispatchEvent(new Event(moduleWriteEvent));
    expect(agreementCustomerData.snapshot(input).state).toBe('pending');
  }),
);

it.effect('a foreground name read shares prefetch and survives cancellation of the old visible page', () =>
  Effect.gen(function* sharedForeground() {
    const started = yield* Deferred.make<boolean>();
    const release = yield* Deferred.make<boolean>();
    mocks.customer.mockImplementation(() =>
      Deferred.succeed(started, true).pipe(
        Effect.andThen(Deferred.await(release)),
        Effect.as({ party: { displayName: 'Joined customer' } }),
      ),
    );
    const background = yield* Effect.forkChild(preloadAgreementCustomers(context, [contract], 7));
    yield* Deferred.await(started);
    const foreground = yield* Effect.forkChild(agreementCustomerData.read(input));
    yield* Effect.yieldNow;
    yield* Fiber.interrupt(background);
    yield* Deferred.succeed(release, true);
    expect(yield* Fiber.join(foreground)).toBe('Joined customer');
    expect(mocks.customer).toHaveBeenCalledTimes(1);
  }),
);

it.effect('keeps independently denied customer-list feedback alongside the authorized base contract', () =>
  Effect.gen(function* independentCustomerList() {
    mocks.customers.mockReturnValue(Effect.fail({ _tag: 'CounterpartyReadForbiddenProblem', status: 403 }));
    yield* agreements.read(agreementsInputOf(props, '')).pipe(Effect.ignore);
    const partial = agreements.snapshot(agreementsInputOf(props, ''));
    expect(partial.state).toBe('failed');
    if (partial.state === 'failed') {
      const summary = Match.value(partial.error).pipe(
        Match.tag('AgreementsSectionsIncomplete', ({ value }) => Option.some(value)),
        Match.orElse(() => Option.none()),
      );
      expect(Option.getOrUndefined(summary)?.records.contracts[0]?.contractRef.resourceId).toBe(id);
      expect(Option.getOrUndefined(summary)?.customers.pipe(Result.getFailure, Option.getOrUndefined)).toBe(
        'forbidden',
      );
    }
    // The selected counterparty has its own governed read, not the customer-list authorization.
    yield* preloadAgreementCustomers(context, [contract], 7);
    expect(yield* agreementCustomerData.read(input)).toBe('Authorized customer');
  }),
);
