import {
  CounterpartyReadResponseSchema,
  CreatePartyResultSchema,
  DuplicateCandidateDetailResponseSchema,
  PartyCommandAlreadyCommittedProblemSchema,
  ResolveDuplicateCandidateCreateResultSchema,
  ResolvePartyCommandCommitResultSchema,
} from '@app/party-registry/api';
import type { CustomerListItem } from '@app/party-registry/api/client';
import { DateTime, Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import type { MerchandiseCommand } from '../../shared/actions/apply-command.ts';
import {
  AKROS_LEGAL_ENTITY_ID,
  assertCommandAllowed,
  assertStorefrontScope,
  staffCommandAllowed,
} from '../../shared/actions/command-guard.ts';
import { orderCustomerSeedEligible } from '../../scripts/order-presentation.ts';
import { OrderIdSchema, PartyIdSchema } from '../../shared/domain/merchandise-model.ts';
import { MerchandiseStateSchema, OrderSchema } from '../../shared/apis/records.ts';
import { convertOrderCustomer, OrderCustomerConversionError } from '../../shared/order-customer-conversion.ts';
import type { OrderCustomerOwners } from '../../shared/order-customer-conversion.ts';
import { MerchandiseLifecycleConflict } from '../../shared/errors/merchandise-lifecycle-conflict.ts';
import { orderCustomerReferenceEligible } from '../../shared/order-customer-reference.ts';
import { evolveMerchandiseState, workingSetRequestOf } from '../../src/services/persistence.service.ts';

const tenantId = '70000000-0000-4000-8000-000000000020';
const partyId = '20000000-0000-4000-8000-000000000001';
const counterpartyId = '20000000-0000-4000-8000-000000000002';
const caseId = '20000000-0000-4000-8000-000000000003';
const decisionId = '20000000-0000-4000-8000-000000000004';
const at = '2026-10-20T08:00:00.000Z';
const ref = (resourceType: string, resourceId: string) => ({
  moduleId: 'party.registry',
  resourceId,
  resourceType,
  tenantId,
});
const created = Schema.decodeUnknownSync(CreatePartyResultSchema)({
  decisionRef: ref('party.registry.party-match-decision', decisionId),
  outcome: 'CREATED',
  partyRef: ref('party.registry.party', partyId),
});
const ambiguous = Schema.decodeUnknownSync(CreatePartyResultSchema)({
  caseRef: ref('party.registry.duplicate-candidate-case', caseId),
  decisionRef: ref('party.registry.party-match-decision', decisionId),
  outcome: 'AMBIGUOUS',
});
const committed = Schema.decodeUnknownSync(PartyCommandAlreadyCommittedProblemSchema)({
  _tag: 'PartyCommandAlreadyCommittedProblem',
  code: 'action_already_committed',
  detail: 'Already committed',
  invocationId: decisionId,
  resolution: 'REFRESH_GOVERNED_READS',
  retryCommand: false,
  status: 409,
  title: 'Already committed',
  type: 'urn:test:already-committed',
});
const order = Schema.decodeUnknownSync(OrderSchema)({
  channel: 'STOREFRONT',
  contact: { email: 'customer@example.invalid', name: 'Jan Novák' },
  createdAt: at,
  currency: 'CZK',
  deliveryAddress: { city: 'Brno', postalCode: '60200', street: 'Ukázková 1' },
  id: 'guest-order',
  lines: [
    {
      productId: 'product',
      productName: 'Šroub',
      quantity: 2,
      sku: 'SKU',
      totalMinor: 200,
      unitPriceMinor: 100,
      vatRate: 21,
    },
  ],
  number: 'OBJ-2026-0001',
  partyId: 'storefront-guest',
  shippingMethod: 'OSOBNI_ODBER',
  shippingMinor: 0,
  status: 'NEW',
  subtotalMinor: 200,
  totalMinor: 200,
  totalVatMinor: 42,
  updatedAt: at,
});
type Owners = OrderCustomerOwners<typeof committed, never>;
const customer: CustomerListItem = {
  city: null,
  companyId: null,
  counterpartyId,
  counterpartyRef: {
    moduleId: 'party.registry',
    resourceId: counterpartyId,
    resourceType: 'party.registry.counterparty',
    tenantId,
  },
  createdAt: at,
  displayName: 'Jan Novák',
  email: null,
  partyId,
  partyRef: { moduleId: 'party.registry', resourceId: partyId, resourceType: 'party.registry.party', tenantId },
  partyRevision: 1,
  phone: null,
  status: 'ACTIVE',
  vatId: null,
};
const candidate = {
  displayName: 'Jan Novák',
  evidenceRefs: [],
  officialIdentifiers: [],
  partyType: 'PERSON',
  provenance: { method: 'MANUAL_ENTRY', source: 'test' },
  subjectEvidence: [],
  validFrom: at,
};
const ownersFor = (overrides: Partial<Owners> = {}) => {
  const calls: string[] = [];
  const owners: Owners = {
    contact: (payload, options) =>
      Effect.sync(() => {
        calls.push('contact');
        expect(payload.verification.state).toBe('UNVERIFIED');
        expect(payload.provenance.authoritative).toBe(false);
        expect(options.idempotencyKey).toBe('merchandise:order-customer:guest-order:email');
      }),
    create: (payload, options) =>
      Effect.sync(() => {
        calls.push('create');
        expect(payload.candidate.officialIdentifiers).toEqual([]);
        expect(payload.candidate.subjectEvidence?.[0]?.subjectKey).toBe('merchandise:order:guest-order');
        expect(options.idempotencyKey).toBe('merchandise:order-customer:guest-order:party');
        return created;
      }),
    customers: Effect.sync(() => {
      calls.push('customers');
      return [];
    }),
    detail: () =>
      Effect.succeed(
        Schema.decodeUnknownSync(DuplicateCandidateDetailResponseSchema)({
          candidate,
          candidateParties: [],
          caseRef: ref('party.registry.duplicate-candidate-case', caseId),
          evaluatedEvidence: [],
          lifecycleState: 'OPEN',
          matchRuleVersion: 'test',
          priorCaseRef: null,
          resolutionOutcome: null,
          resolutionReason: null,
          resolvedAt: null,
          revision: 1,
        }),
      ),
    onboard: (payload, options) =>
      Effect.sync(() => {
        calls.push('onboard');
        expect(payload.partyRef).toEqual(customer.partyRef);
        expect(payload.counterpartyProvenance.evidenceReference).toBe('merchandise:order:guest-order');
        expect(payload.validFrom).toBe(at);
        expect(options.idempotencyKey).toBe('merchandise:order-customer:guest-order:onboard');
        return { counterpartyRef: customer.counterpartyRef };
      }),
    recover: () =>
      Effect.succeed(
        Schema.decodeUnknownSync(ResolvePartyCommandCommitResultSchema)({
          _tag: 'PartyCommandCommitResolution',
          createResult: created,
          invocationId: decisionId,
          retryCommand: false,
          state: 'COMMITTED',
        }),
      ),
    resolve: () =>
      Effect.sync(() => {
        calls.push('resolve');
        return Schema.decodeUnknownSync(ResolveDuplicateCandidateCreateResultSchema)({
          caseRef: ref('party.registry.duplicate-candidate-case', caseId),
          decisionRef: ref('party.registry.party-match-decision', decisionId),
          lifecycleState: 'RESOLVED',
          outcome: 'CREATE_NEW',
          partyRef: customer.partyRef,
        });
      }),
    ...overrides,
  };
  return { calls, owners };
};

it.effect('explicit conversion calls the native owners with per-order evidence and unverified contact', () =>
  Effect.gen(function* convert() {
    const { calls, owners } = ownersFor();
    expect(yield* convertOrderCustomer(order, owners)).toEqual({
      counterpartyRef: customer.counterpartyRef,
      partyRef: customer.partyRef,
    });
    expect(calls).toEqual(['create', 'customers', 'onboard', 'contact']);
  }),
);
it.effect('uses native review-create only when the case has no identity candidates', () =>
  Effect.gen(function* review() {
    const { calls, owners } = ownersFor({ create: () => Effect.succeed(ambiguous) });
    yield* convertOrderCustomer(order, owners);
    expect(calls).toContain('resolve');
  }),
);
it.effect('does not resolve, onboard or link a case containing a candidate Party', () =>
  Effect.gen(function* rejectCandidate() {
    const { calls, owners } = ownersFor({
      create: () => Effect.succeed(ambiguous),
      detail: () =>
        Effect.succeed(
          Schema.decodeUnknownSync(DuplicateCandidateDetailResponseSchema)({
            candidate,
            candidateParties: [customer.partyRef],
            caseRef: ref('party.registry.duplicate-candidate-case', caseId),
            evaluatedEvidence: [],
            lifecycleState: 'OPEN',
            matchRuleVersion: 'test',
            priorCaseRef: null,
            resolutionOutcome: null,
            resolutionReason: null,
            resolvedAt: null,
            revision: 1,
          }),
        ),
    });
    const error = yield* convertOrderCustomer(order, owners).pipe(Effect.flip);
    expect(Schema.is(OrderCustomerConversionError)(error)).toBe(true);
    expect(calls).toEqual([]);
  }),
);
it.effect('recovers exact committed Create and skips the existing native CUSTOMER on retry', () =>
  Effect.gen(function* retry() {
    const { calls, owners } = ownersFor({
      contact: () => Effect.fail(committed),
      create: () => Effect.fail(committed),
      customers: Effect.succeed([customer]),
    });
    expect(yield* convertOrderCustomer(order, owners)).toEqual({
      counterpartyRef: customer.counterpartyRef,
      partyRef: customer.partyRef,
    });
    expect(calls).toEqual([]);
  }),
);
it.effect('stops if original Create recovery has no authoritative result', () =>
  Effect.gen(function* unresolvedCreate() {
    const { calls, owners } = ownersFor({
      create: () => Effect.fail(committed),
      recover: () =>
        Effect.succeed(
          Schema.decodeUnknownSync(ResolvePartyCommandCommitResultSchema)({
            _tag: 'PartyCommandCommitResolution',
            invocationId: decisionId,
            retryCommand: false,
            state: 'RUNNING',
          }),
        ),
    });
    const error = yield* convertOrderCustomer(order, owners).pipe(Effect.flip);
    expect(Schema.is(OrderCustomerConversionError)(error)).toBe(true);
    expect(calls).toEqual([]);
  }),
);
it.effect('re-reads native customers after an interrupted onboarding has already committed', () =>
  Effect.gen(function* onboardRetry() {
    let reads = 0;
    const { owners } = ownersFor({
      customers: Effect.sync(() => {
        reads += 1;
        return reads === 1 ? [] : [customer];
      }),
      onboard: () => Effect.fail(committed),
    });
    expect(yield* convertOrderCustomer(order, owners)).toEqual({
      counterpartyRef: customer.counterpartyRef,
      partyRef: customer.partyRef,
    });
    expect(reads).toBe(2);
  }),
);
it.effect('never infers continuity from a different Party with the same name and email', () =>
  Effect.gen(function* noEmailMatch() {
    const { calls, owners } = ownersFor({ customers: Effect.succeed([{ ...customer, partyId: caseId }]) });
    yield* convertOrderCustomer(order, owners);
    expect(calls).toContain('onboard');
  }),
);
it.effect('rejects a staff order before any Party writes', () =>
  Effect.gen(function* rejectStaff() {
    const { calls, owners } = ownersFor();
    yield* convertOrderCustomer({ ...order, channel: 'STAFF' }, owners).pipe(Effect.flip);
    expect(calls).toEqual([]);
  }),
);

const link: Extract<MerchandiseCommand, { readonly _tag: 'LinkOrderCustomer' }> = {
  _tag: 'LinkOrderCustomer',
  counterpartyRef: customer.counterpartyRef,
  expectedPartyId: order.partyId,
  id: order.id,
  partyRef: customer.partyRef,
};
const record = Schema.decodeUnknownSync(CounterpartyReadResponseSchema)({
  counterpartyRef: customer.counterpartyRef,
  createdAt: at,
  currentRoles: [
    {
      endProvenance: null,
      provenance: { evidenceReference: 'order', method: 'STAFF', source: 'test' },
      recordedAt: at,
      rolePeriodRef: ref('party.registry.counterparty-role-period', decisionId),
      roleType: 'CUSTOMER',
      state: 'ACTIVE',
      validFrom: at,
      validTo: null,
    },
  ],
  legalEntityRef: {
    moduleId: 'core.identity',
    resourceId: AKROS_LEGAL_ENTITY_ID,
    resourceType: 'core.identity.legal-entity',
    tenantId,
  },
  party: {
    archived: false,
    canonicalPartyRef: customer.partyRef,
    displayName: 'Jan Novák',
    partyType: 'PERSON',
    storedPartyRef: customer.partyRef,
  },
});
it('links only a current unarchived native CUSTOMER of the exact tenant and company', () => {
  const scope = { legalEntityId: AKROS_LEGAL_ENTITY_ID, tenantId };
  expect(orderCustomerReferenceEligible(link, record, scope, at)).toBe(true);
  for (const invalid of [
    { ...record, currentRoles: [] },
    { ...record, party: { ...record.party, archived: true } },
    { ...record, party: { ...record.party, canonicalPartyRef: { ...customer.partyRef, resourceId: caseId } } },
    { ...record, legalEntityRef: { ...record.legalEntityRef, resourceId: partyId } },
    { ...record, legalEntityRef: { ...record.legalEntityRef, tenantId: partyId } },
    { ...record, currentRoles: record.currentRoles.map((role) => ({ ...role, validTo: at })) },
  ]) {
    expect(orderCustomerReferenceEligible(link, invalid, scope, at)).toBe(false);
  }
});
it.effect('linking preserves financial/stock snapshots and is idempotent after completion', () =>
  Effect.gen(function* linkCustomer() {
    const state = Schema.decodeUnknownSync(MerchandiseStateSchema)({ movements: [], orders: [], products: [] });
    const before = { ...state, orders: [order] };
    const input = { actor: { principalId: partyId, tenantId }, now: DateTime.makeUnsafe(at), resourceId: 'link' };
    const result = yield* evolveMerchandiseState(before, link, input);
    expect(result.state.orders[0]?.partyId).toBe(partyId);
    expect(result.state.orders[0]?.lines).toBe(order.lines);
    expect(result.state.orders[0]?.totalMinor).toBe(order.totalMinor);
    expect(result.state.orders[0]?.contact).toBe(order.contact);
    expect(result.state.movements).toBe(before.movements);
    expect(workingSetRequestOf(link, 'link')).toEqual({ orderIds: [order.id] });
    const repeated = yield* evolveMerchandiseState(result.state, link, input);
    expect(repeated.state).toBe(result.state);
  }),
);
it.effect('storefront, non-human principals and dispatch cannot convert order customers', () =>
  Effect.gen(function* guard() {
    yield* assertCommandAllowed('non_human', 'LinkOrderCustomer').pipe(Effect.flip);
    yield* assertStorefrontScope('api_key', AKROS_LEGAL_ENTITY_ID, 'LinkOrderCustomer').pipe(Effect.flip);
    expect(staffCommandAllowed(AKROS_LEGAL_ENTITY_ID, false, 'LinkOrderCustomer')).toBe(false);
    expect(staffCommandAllowed(AKROS_LEGAL_ENTITY_ID, true, 'LinkOrderCustomer')).toBe(true);
  }),
);

it('bootstrap excludes real, unknown, non-storefront and cleaned orders unless explicitly authorized', () => {
  const seed = { ...order, demo: true, id: Schema.decodeSync(OrderIdSchema)('2d4f33c1-d9ca-5bc8-8c9d-1ea4f78ab384') };
  expect(orderCustomerSeedEligible(seed, false)).toBe(true);
  expect(orderCustomerSeedEligible(order, false)).toBe(false);
  expect(orderCustomerSeedEligible({ ...order, demo: true }, false)).toBe(false);
  expect(orderCustomerSeedEligible({ ...seed, demo: false }, false)).toBe(false);
  expect(orderCustomerSeedEligible(order, true)).toBe(true);
  expect(orderCustomerSeedEligible({ ...seed, channel: 'STAFF' }, true)).toBe(false);
  expect(
    orderCustomerSeedEligible(
      { ...seed, demoCleanup: { actor: { principalId: partyId, tenantId }, at: order.createdAt, reason: 'Úklid' } },
      true,
    ),
  ).toBe(false);
});
it.effect('a stale order link cannot overwrite a changed customer', () =>
  Effect.gen(function* staleLink() {
    const state = Schema.decodeUnknownSync(MerchandiseStateSchema)({ movements: [], orders: [], products: [] });
    const error = yield* evolveMerchandiseState(
      { ...state, orders: [order] },
      { ...link, expectedPartyId: Schema.decodeSync(PartyIdSchema)('different-party') },
      {
        actor: { principalId: partyId, tenantId },
        now: DateTime.makeUnsafe(at),
        resourceId: 'link',
      },
    ).pipe(Effect.flip);
    expect(Schema.is(MerchandiseLifecycleConflict)(error)).toBe(true);
    expect(order.partyId).toBe('storefront-guest');
  }),
);
