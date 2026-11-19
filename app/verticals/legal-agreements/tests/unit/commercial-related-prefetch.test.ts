// @rstest-environment happy-dom
import { Deferred, Effect, Fiber, Match, Option, Result, Schema } from 'effect';
import { afterEach, beforeEach, expect, it } from 'effect-rstest';
import { createElement } from 'react';
import { moduleChangeEvent, moduleWriteEvent, pageDataScopeKey } from '@app/shared-contracts/page-data';
import { RecordsApi, RecordsResponseSchema, RecordsForbiddenProblemSchema } from '../../shared/apis/records.ts';
import type { RecordsRequest, RecordsResponse } from '../../shared/apis/records.ts';
import {
  CounterpartyReadApi,
  CounterpartyReadResponseSchema,
  CounterpartyReadForbiddenProblemSchema,
  CounterpartyReadUnavailableProblemSchema,
} from '@app/party-registry/api';
import type { CounterpartyReadRequest, CounterpartyReadResponse } from '@app/party-registry/api';
import {
  CustomerListApi,
  CustomerListForbiddenProblemSchema,
} from '../../../party-registry/shared/apis/customer-list.ts';
import type { CustomerListResponse } from '../../../party-registry/shared/apis/customer-list.ts';
import {
  networkIdle,
  networkQuietExcept,
  pinTestDocument,
  serveApi,
  shellGatewayIssuer,
  streamingBrowserNetwork,
} from '@app/shared-contracts/testing/http-double';
import { text, unmountAll } from '@app/admin-ui/testing/module-ui';
import { HttpApiBuilder } from '@modern-js/bff-effect/effect-edge';
import { mountInRoute } from '../support/module-ui.ts';
import {
  agreementCustomerData,
  agreements,
  agreementsInputOf,
  preloadAgreementCustomers,
  preloadPage,
  useAgreementCustomer,
} from '../../src/routes/[lang]/smlouvy/agreements-data.ts';

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
const customer = (displayName: string): CounterpartyReadResponse =>
  Schema.decodeUnknownSync(CounterpartyReadResponseSchema)({
    counterpartyRef: contract.counterpartyRef,
    createdAt: '2026-11-03T00:00:00.000Z',
    currentRoles: [],
    legalEntityRef: {
      moduleId: 'core.identity',
      resourceId: id,
      resourceType: 'core.identity.legal-entity',
      tenantId: ref.tenantId,
    },
    party: {
      archived: false,
      canonicalPartyRef: {
        moduleId: 'party.registry',
        resourceId: id,
        resourceType: 'party.registry.party',
        tenantId: ref.tenantId,
      },
      displayName,
      partyType: 'ORGANIZATION',
      storedPartyRef: {
        moduleId: 'party.registry',
        resourceId: id,
        resourceType: 'party.registry.party',
        tenantId: ref.tenantId,
      },
    },
  });
const customerForbidden = CounterpartyReadForbiddenProblemSchema.make({
  detail: 'Customer read denied',
  status: 403,
  title: 'Forbidden',
  type: 'https://ontos.dev/problems/counterparty-read-forbidden',
});
const customerUnavailable = CounterpartyReadUnavailableProblemSchema.make({
  detail: 'Customer unavailable',
  retryable: true,
  status: 503,
  title: 'Unavailable',
  type: 'https://ontos.dev/problems/counterparty-read-unavailable',
});
const recordsForbidden = RecordsForbiddenProblemSchema.make({
  detail: 'Records read denied',
  status: 403,
  title: 'Forbidden',
  type: 'https://ontos.dev/problems/records-forbidden',
});
const customerListForbidden = CustomerListForbiddenProblemSchema.make({
  detail: 'Customer list denied',
  status: 403,
  title: 'Forbidden',
  type: 'https://ontos.dev/problems/customer-list-forbidden',
});
const customerReads: CounterpartyReadRequest[] = [];
const recordsReads: RecordsRequest[] = [];
let customerAnswer: Effect.Effect<CounterpartyReadResponse, typeof customerForbidden | typeof customerUnavailable> =
  Effect.succeed(customer('Authorized customer'));
let recordsAnswer: Effect.Effect<RecordsResponse, typeof recordsForbidden> = Effect.succeed(records);
let customerListAnswer: Effect.Effect<CustomerListResponse, typeof customerListForbidden> = Effect.succeed({
  items: [],
});
const Owner = RecordsApi.prefix('/legal-agreements-api');
const Party = CounterpartyReadApi.prefix('/party-registry-api');
const Customers = CustomerListApi.prefix('/party-registry-api');
const applications = [
  shellGatewayIssuer({ 'legal-agreements': '/legal-agreements-api', 'party-registry': '/party-registry-api' })
    .application,
  serveApi(
    Owner,
    HttpApiBuilder.group(Owner, 'records', (g) =>
      g.handle('execute', ({ payload }) =>
        Effect.suspend(() => {
          recordsReads.push(payload);
          return recordsAnswer;
        }),
      ),
    ),
  ),
  serveApi(
    Party,
    HttpApiBuilder.group(Party, 'counterpartyRead', (g) =>
      g.handle('execute', ({ payload }) =>
        Effect.suspend(() => {
          customerReads.push(payload);
          return customerAnswer;
        }),
      ),
    ),
  ),
  serveApi(
    Customers,
    HttpApiBuilder.group(Customers, 'customerList', (g) =>
      g.handle('execute', () => Effect.suspend(() => customerListAnswer)),
    ),
  ),
] as const;
const network = streamingBrowserNetwork(...applications);
afterEach(unmountAll);
beforeEach(() => {
  customerReads.length = 0;
  recordsReads.length = 0;
  agreements.invalidate();
  agreementCustomerData.invalidate();
  recordsAnswer = Effect.succeed(records);
  customerListAnswer = Effect.succeed({ items: [] });
  customerAnswer = Effect.succeed(customer('Authorized customer'));
});
const Detail = () => {
  const value = useAgreementCustomer(context, contract, 7);
  return createElement('p', null, value.customerName ?? value.customerNameFeedback);
};
it.layer(network, { excludeTestServices: true })('commercial related prefetch', (suite) => {
  suite.effect(
    'preloads the exact cold deep link, then another selection reuses base records without rereading them',
    () =>
      Effect.gen(function* test() {
        yield* pinTestDocument;
        yield* Effect.promise(() => preloadPage(props));
        yield* networkIdle;
        expect(recordsReads).toHaveLength(1);
        expect(customerReads).toHaveLength(1);
        expect(customerReads[0]).toEqual({ counterpartyRef: contract.counterpartyRef });
        const selected = agreementCustomerData.snapshot(input);
        expect(selected.state).toBe('ready');
        const next = { ...props, search: `?resourceId=${otherId}` };
        yield* Effect.promise(() => preloadPage(next));
        yield* networkIdle;
        expect(recordsReads).toHaveLength(1);
        expect(customerReads).toHaveLength(2);
        expect(agreements.key(agreementsInputOf(props, ''))).toBe(agreements.key(agreementsInputOf(next, '')));
      }),
  );
  suite.effect('never translates a missing or invalid contract identity into a customer lookup', () =>
    Effect.gen(function* test() {
      yield* pinTestDocument;
      yield* Effect.promise(() =>
        preloadPage({ ...props, search: '?resourceId=10000000-0000-4000-8000-000000000099' }),
      );
      yield* Effect.promise(() => preloadPage({ ...props, search: '?resourceId=invalid' }));
      yield* networkIdle;
      expect(customerReads).toHaveLength(0);
      expect(recordsReads).toHaveLength(1);
    }),
  );
  suite.effect('separates every scope field, revision, module and reference tenant', () =>
    Effect.gen(function* test() {
      yield* pinTestDocument;
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
        contract: {
          ...contract,
          counterpartyRef: { ...contract.counterpartyRef, tenantId: '10000000-0000-4000-8000-000000000004' },
        },
      });
      yield* networkIdle;
      expect(customerReads).toHaveLength(7);
    }),
  );
  suite.effect('skips speculative reads without full identity and never caches a denied name as success', () =>
    Effect.gen(function* test() {
      yield* pinTestDocument;
      yield* preloadAgreementCustomers(undefined, [contract], 7);
      yield* preloadAgreementCustomers({ ...context, tenantId: '' }, [contract], 7);
      yield* networkIdle;
      expect(customerReads).toHaveLength(0);
      customerAnswer = Effect.fail(customerForbidden);
      yield* preloadAgreementCustomers(context, [contract], 7);
      expect(agreementCustomerData.snapshot(input).state).toBe('failed');
      customerAnswer = Effect.succeed(customer('Now allowed'));
      expect(yield* agreementCustomerData.read(input)).toBe('Now allowed');
      yield* networkIdle;
      expect(customerReads).toHaveLength(2);
    }),
  );
  suite.effect('preserves the base contract when name lookup fails and drops it after a primary denial', () =>
    Effect.gen(function* test() {
      yield* pinTestDocument;
      const query = agreementsInputOf(props, '');
      yield* agreements.read(query);
      customerAnswer = Effect.fail(customerUnavailable);
      yield* preloadAgreementCustomers(context, [contract], 7);
      const base = agreements.snapshot(query);
      expect(base.state).toBe('ready');
      if (base.state === 'ready') {
        expect(Option.getOrUndefined(base.value)?.records.contracts[0]?.contractRef.resourceId).toBe(id);
      }
      recordsAnswer = Effect.fail(recordsForbidden);
      yield* agreements.refresh(query);
      expect(agreements.snapshot(query).state).toBe('failed');
    }),
  );
  suite.effect('starts at most two visible rows and aborts active/queued prefetch on page change', () =>
    Effect.gen(function* test() {
      yield* pinTestDocument;
      const started = yield* Deferred.make<boolean>();
      const stopped = yield* Deferred.make<boolean>();
      let active = 0;
      let aborted = 0;
      customerAnswer = Effect.gen(function* blocked() {
        active += 1;
        if (active === 2) {
          yield* Deferred.succeed(started, true);
        }
        return yield* Effect.never;
      }).pipe(
        Effect.onInterrupt(() =>
          Effect.gen(function* recordAbort() {
            aborted += 1;
            if (aborted === 2) {
              yield* Deferred.succeed(stopped, true);
            }
          }),
        ),
      );
      const third = {
        ...contract,
        contractRef: { ...contract.contractRef, resourceId: '10000000-0000-4000-8000-000000000005' },
      };
      const fiber = yield* Effect.forkChild(preloadAgreementCustomers(context, [...records.contracts, third], 7));
      yield* Deferred.await(started);
      yield* networkQuietExcept(2);
      expect(active).toBe(2);
      yield* Fiber.interrupt(fiber);
      yield* Deferred.await(stopped);
      expect(aborted).toBe(2);
      yield* networkIdle;
      expect(customerReads).toHaveLength(2);
    }),
  );
  suite.effect('never returns an old name after live invalidation, including a newly denied owner read', () =>
    Effect.gen(function* test() {
      yield* pinTestDocument;
      yield* preloadAgreementCustomers(context, [contract], 7);
      window.dispatchEvent(new Event(moduleChangeEvent));
      expect(agreementCustomerData.snapshot(input).state).toBe('pending');
      customerAnswer = Effect.fail(customerForbidden);
      yield* agreementCustomerData.read(input).pipe(Effect.ignore);
      expect(agreementCustomerData.snapshot(input).state).toBe('failed');
      yield* mountInRoute(createElement(Detail));
      yield* networkIdle;
      expect(text()).not.toContain('Authorized customer');
      unmountAll();
      window.dispatchEvent(new Event(moduleWriteEvent));
      expect(agreementCustomerData.snapshot(input).state).toBe('pending');
    }),
  );

  suite.effect('keeps independently denied customer-list feedback alongside the authorized base contract', () =>
    Effect.gen(function* independentCustomerList() {
      yield* pinTestDocument;
      customerListAnswer = Effect.fail(customerListForbidden);
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
});
