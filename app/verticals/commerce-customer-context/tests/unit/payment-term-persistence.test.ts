import type { OperationalScope } from '@app/core-runtime';
import { paymentTermCatalogPort } from '../../src/integrations/payment-term-catalog.ts';
import { ScopedRoutineInvocationError, ReadHandlerUnavailable } from '@app/core-runtime';
import type { CurrentPaymentTermsResponse } from '@app/payment-term-catalog-contracts/current-payment-terms';
import { Effect, Option, Predicate, Result, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import type { CustomerPaymentTermsState } from '../../shared/domain/payment-term-contracts.ts';
import { PaymentTermsDependencyUnavailable } from '../../shared/domain/payment-term-errors.ts';
import { stableRevision } from '../../src/integrations/order-finalization-pricing-context.ts';
import {
  bindPreparedPaymentTermCatalog,
  paymentTermsSnapshotUnchanged,
} from '../../src/services/payment-terms-action-preflight.ts';
import { ProfileReconciliationOwnerVerificationRequestSchema } from '../../shared/actions/resolve-profile-reconciliation.ts';
import type { ChangeCustomerPaymentTermsServices } from '../../src/actions/change-customer-payment-terms.action.ts';
import type { CustomerPaymentTermsScopedRoutineInvoker } from '../../src/persistence/payment-term-persistence.ts';
import {
  customerChangeDefinitionRequests,
  loadCustomerChangeSnapshot,
  loadRetailChangeSnapshot,
  retailChangeDefinitionRequests,
  makeChangeCustomerPaymentTermsServices,
  makeCustomerPaymentTermEntitlementReadServices,
  makePaymentTermAffectedUseAssessmentServices,
  makePaymentTermsResolutionServices,
  paymentTermsRoutineAllowlist,
  paymentTermsPersistenceForTransaction,
  verifyPaymentTermsReconciliationOwner,
} from '../../src/persistence/payment-term-persistence.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const legalEntityId = '22222222-2222-4222-8222-222222222222';
const profileId = '33333333-3333-4333-8333-333333333333';
const counterpartyId = '44444444-4444-4444-8444-444444444444';
const entitlementId = '55555555-5555-4555-8555-555555555555';
const paymentTermId = '66666666-6666-4666-8666-666666666666';
const aliasPaymentTermId = 'aaaaaaaa-6666-4666-8666-666666666666';
const semanticRevisionId = '77777777-7777-4777-8777-777777777777';
const actionInvocationId = '88888888-8888-4888-8888-888888888888';
const principalId = '99999999-9999-4999-8999-999999999999';
type PaymentTermDefinition = CurrentPaymentTermsResponse['current'][number];

const profileRef = {
  moduleId: 'commerce.customer-context',
  resourceId: profileId,
  resourceType: 'commerce.customer-context.counterparty-purchasing-profile',
  tenantId,
} as const;
const counterpartyRef = {
  moduleId: 'party.registry',
  resourceId: counterpartyId,
  resourceType: 'party.registry.counterparty',
  tenantId,
} as const;
const paymentTermRef = {
  moduleId: 'payment.term-catalog',
  resourceId: paymentTermId,
  resourceType: 'payment.term-catalog.payment-term',
  tenantId,
} as const;
const aliasPaymentTermRef = {
  ...paymentTermRef,
  resourceId: aliasPaymentTermId,
} as const;
const entitlementRef = {
  moduleId: 'commerce.customer-context',
  resourceId: entitlementId,
  resourceType: 'commerce.customer-context.customer-payment-term-entitlement',
  tenantId,
} as const;
const state = (revision = 1): CustomerPaymentTermsState => ({
  entitlements: [],
  preferences: [],
  profileRef,
  revision,
});

const provenance = {
  actionInvocationId,
  actorPrincipalId: principalId,
  at: '2026-01-01T00:00:00.000Z',
  reason: 'Catalog fixture',
} as const;

const currentDefinition = (): PaymentTermDefinition => ({
  code: 'NET_30',
  compatibilityId: 'net-days.v1',
  created: provenance,
  definitionRevisionId: semanticRevisionId,
  description: 'Payment due 30 calendar days after invoice issue.',
  lifecycle: {
    effectiveFrom: '2026-01-01T00:00:00.000Z',
    effectiveTo: null,
    state: 'ACTIVE',
  },
  metadataRevision: 1,
  name: 'Net 30',
  paymentTermRef,
  retired: null,
  semanticFingerprint: 'a'.repeat(64),
  semanticRevisionId,
  semantics: {
    calculationRuleVersion: 2,
    calendarRule: 'CALENDAR_DAYS',
    days: 30,
    dueDateAnchor: 'INVOICE_ISSUE_DATE',
    kind: 'NET_DAYS',
  },
  updated: provenance,
});

const scope = {
  authBindingId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  authContextRef: 'better-auth-session:payment-terms-test',
  authMethod: 'session',
  correlationId: 'correlation-1',
  legalEntityId,
  principalId,
  tenantId,
} satisfies OperationalScope & { readonly legalEntityId: string };

const row = (
  outcome: 'APPLIED' | 'PAYMENT_TERM_RETIREMENT_RESERVED' | 'PRESENT' | 'REVISION_CONFLICT' | 'UNCHANGED',
  payload: CustomerPaymentTermsState | null,
  currentRevision: number | null,
) => ({ current_revision: currentRevision, outcome, payload });

const transactionReturning = (
  ...responses: readonly (readonly object[])[]
): CustomerPaymentTermsScopedRoutineInvoker => {
  let index = 0;
  return {
    invoke: (routine) => {
      const response = responses[index] ?? [];
      index += 1;
      return Effect.forEach(response, (item) => Schema.decodeUnknownEffect(Schema.toType(routine.resultSchema))(item), {
        concurrency: 1,
      }).pipe(Effect.orDie);
    },
  };
};

const actionContextFor = (
  services: ChangeCustomerPaymentTermsServices,
): Parameters<ChangeCustomerPaymentTermsServices['change']>[1] => ({
  actionInvocationId,
  addDomainEvent: () => Effect.die('not used by persistence adapter test'),
  addOutboxMessage: () => Effect.die('not used by persistence adapter test'),
  compositionRevision: 'a'.repeat(64),
  recordAuditEvidence: () => Effect.die('not used by persistence adapter test'),
  recordDataAccess: () => Effect.die('not used by persistence adapter test'),
  scope,
  services,
});

const persistenceContext = (invoker: CustomerPaymentTermsScopedRoutineInvoker) => ({
  invoker,
  scope,
});

it('declares only immutable scope-injected Customer Payment Terms routines', () => {
  expect(paymentTermsRoutineAllowlist.map(({ name, routineKey }) => [name, routineKey])).toEqual([
    ['read_customer_payment_terms', 'payment-terms.read-state'],
    ['assess_payment_term_entitlement_use', 'payment-terms.assess-entitlement-use'],
    ['persist_customer_payment_terms', 'payment-terms.persist-state'],
    ['resolve_legacy_payment_term_grant_intent_v1', 'payment-terms.resolve-legacy-grant-intent'],
    ['reserve_payment_term_retirement', 'payment-terms.reserve-retirement'],
    ['verify_payment_terms_reconciliation_owner', 'payment-terms.reconciliation-owner-verify'],
  ]);
  for (const routine of paymentTermsRoutineAllowlist) {
    expect(Object.isFrozen(routine)).toBe(true);
    expect(routine.ownerModuleKey).toBe('commerce.customer-context');
    expect(routine.parameters.slice(0, 2)).toEqual([
      { source: 'tenantId', type: 'uuid' },
      { source: 'legalEntityId', type: 'uuid' },
    ]);
  }
});

it.effect('derives a PAYMENT_TERMS receipt from the owner routine, never caller evidence', () =>
  Effect.gen(function* paymentTermsOwnerVerification() {
    let invokedValues: readonly unknown[] = [];
    const transaction: CustomerPaymentTermsScopedRoutineInvoker = {
      invoke: (routine, values) => {
        invokedValues = values;
        return Effect.forEach(
          [
            {
              outcome: 'VERIFIED',
              payload: {
                correlationRef: 'payment-terms-owner:trusted-correlation',
                evidenceRef: 'payment-terms-owner:trusted-evidence',
                owner: 'PAYMENT_TERMS',
                status: 'RESOLVED',
              },
            },
          ],
          (item) => Schema.decodeUnknownEffect(Schema.toType(routine.resultSchema))(item),
          { concurrency: 1 },
        ).pipe(Effect.orDie);
      },
    };
    const request = Schema.decodeUnknownSync(ProfileReconciliationOwnerVerificationRequestSchema)({
      caseRef: {
        moduleId: 'commerce.customer-context',
        resourceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        resourceType: 'commerce.customer-context.profile-reconciliation-case',
        tenantId,
      },
      desiredOutcome: {
        evidenceRef: 'caller-fabricated-evidence',
        owner: 'PAYMENT_TERMS',
        status: 'RESOLVED',
      },
      effectiveAt: '2026-10-01T00:00:00.000Z',
      expectedCaseRevision: 2,
      expectedEventVersion: '4',
      reason: 'Preserve independently valid Payment Terms facts',
      resultingState: 'ACTIVE',
      survivorProfileRef: { ...profileRef, kind: 'COUNTERPARTY' },
    });

    const result = yield* verifyPaymentTermsReconciliationOwner(transaction, {
      actionInvocationId,
      principalId,
      request,
    });

    expect(Predicate.isTagged(result, 'VERIFIED')).toBe(true);
    expect(result).toMatchObject({
      correlationRef: 'payment-terms-owner:trusted-correlation',
      durableOutcome: {
        evidenceRef: 'payment-terms-owner:trusted-evidence',
        owner: 'PAYMENT_TERMS',
        status: 'RESOLVED',
      },
    });
    expect(invokedValues).toEqual([
      request.caseRef.resourceId,
      'PAYMENT_TERMS',
      profileId,
      'ACTIVE',
      'RESOLVED',
      2,
      4n,
      '2026-10-01T00:00:00.000Z',
      request.reason,
      actionInvocationId,
      principalId,
      'customer-payment-terms-reconciliation.v1',
    ]);
  }),
);

it.effect('counts canonical and alias Payment Terms atomically in one owner snapshot', () =>
  Effect.gen(function* affectedUseAssessment() {
    const invocations: unknown[] = [];
    const response = [
      {
        current_customer_entitlement_count: 1,
        evidence_reference: 'commerce.customer-context:payment-term-entitlement-use-set:fingerprint:1:2:1',
        observed_at: '2026-09-09T12:00:00.000Z',
        outcome: 'ASSESSED',
      },
    ];
    const invoker: CustomerPaymentTermsScopedRoutineInvoker = {
      invoke: (routine, values) => {
        invocations.push(values);
        return Effect.forEach(
          response,
          (item) => Schema.decodeUnknownEffect(Schema.toType(routine.resultSchema))(item),
          {
            concurrency: 1,
          },
        ).pipe(Effect.orDie);
      },
    };
    const services = makePaymentTermAffectedUseAssessmentServices(persistenceContext(invoker));
    const result = yield* services.assess({
      at: '2026-10-01T00:00:00.000Z',
      paymentTermRefs: [paymentTermRef, aliasPaymentTermRef, aliasPaymentTermRef],
    });
    expect(result).toEqual({
      currentCustomerEntitlementCount: 1,
      evidenceReference: 'commerce.customer-context:payment-term-entitlement-use-set:fingerprint:1:2:1',
      observedAt: '2026-09-09T12:00:00.000Z',
    });
    expect(invocations).toEqual([
      [[paymentTermRef.resourceId, aliasPaymentTermRef.resourceId], '2026-10-01T00:00:00.000Z'],
    ]);
  }),
);

it.effect('persists a catalog-validated entitlement with Action attribution and CAS state', () =>
  Effect.gen(function* persistEntitlement() {
    const nextState: CustomerPaymentTermsState = {
      entitlements: [
        {
          effectiveFrom: '2026-10-01T00:00:00.000Z',
          entitlementRef,
          paymentTermRef,
          semanticRevisionId,
          status: 'ACTIVE',
        },
      ],
      preferences: [],
      profileRef,
      revision: 2,
    };
    const transaction = transactionReturning([row('PRESENT', state(), 1)], [row('APPLIED', nextState, 2)]);
    const services = makeChangeCustomerPaymentTermsServices(persistenceContext(transaction), {
      resolveDefinitions: () => Effect.succeed([currentDefinition()]),
    });
    const result = yield* services.change(
      {
        changes: [
          {
            _tag: 'GRANT_ENTITLEMENT',
            effectiveFrom: '2026-10-01T00:00:00.000Z',
            entitlementRef,
            paymentTermRef,
            semanticRevisionId,
          },
        ],
        counterpartyRef,
        expectedRevision: 1,
        profileRef,
        reason: 'Approved terms',
      },
      actionContextFor(services),
    );
    expect(result).toEqual({ changed: true, state: nextState });
  }),
);

it.effect('rejects a catalog definition that is retired before the requested effective instant', () =>
  Effect.gen(function* retiredDefinition() {
    const services = makeChangeCustomerPaymentTermsServices(
      persistenceContext(transactionReturning([row('PRESENT', state(), 1)])),
      {
        resolveDefinitions: () =>
          Effect.succeed([
            {
              ...currentDefinition(),
              lifecycle: {
                effectiveFrom: '2026-01-01T00:00:00.000Z',
                effectiveTo: '2026-09-01T00:00:00.000Z',
                state: 'RETIRED',
              },
              retired: provenance,
            },
          ]),
      },
    );
    const failure = yield* Effect.flip(
      services.change(
        {
          changes: [
            {
              _tag: 'GRANT_ENTITLEMENT',
              effectiveFrom: '2026-10-01T00:00:00.000Z',
              entitlementRef,
              paymentTermRef,
              semanticRevisionId,
            },
          ],
          counterpartyRef,
          expectedRevision: 1,
          profileRef,
          reason: 'Approved terms',
        },
        actionContextFor(services),
      ),
    );
    expect(failure).toMatchObject({ code: 'PAYMENT_TERM_NOT_CURRENT' });
  }),
);

it.effect('fails closed when a new entitlement cannot be verified by the canonical catalog', () =>
  Effect.gen(function* unavailableCatalog() {
    const services = makeChangeCustomerPaymentTermsServices(
      persistenceContext(transactionReturning([row('PRESENT', state(), 1)])),
    );
    const failure = yield* Effect.flip(
      services.change(
        {
          changes: [
            {
              _tag: 'GRANT_ENTITLEMENT',
              effectiveFrom: '2026-10-01T00:00:00.000Z',
              entitlementRef,
              paymentTermRef,
              semanticRevisionId,
            },
          ],
          counterpartyRef,
          expectedRevision: 1,
          profileRef,
          reason: 'Approved terms',
        },
        actionContextFor(services),
      ),
    );
    expect(failure).toMatchObject({
      code: 'DEPENDENCY_UNAVAILABLE',
      retryable: true,
    });
  }),
);

it.effect('maps the routine CAS result to the declared Action revision conflict', () =>
  Effect.gen(function* revisionConflict() {
    const services = makeChangeCustomerPaymentTermsServices(
      persistenceContext(transactionReturning([row('PRESENT', state(3), 3)], [row('REVISION_CONFLICT', null, 4)])),
      { resolveDefinitions: () => Effect.succeed([]) },
    );
    const failure = yield* Effect.flip(
      services.change(
        {
          changes: [
            {
              _tag: 'CLEAR_PREFERENCE',
              effectiveAt: '2026-10-01T00:00:00.000Z',
            },
          ],
          counterpartyRef,
          expectedRevision: 3,
          profileRef,
          reason: 'Clear preference',
        },
        actionContextFor(services),
      ),
    );
    expect(failure).toMatchObject({
      code: 'REVISION_CONFLICT',
      currentRevision: 4,
    });
  }),
);

it.effect('maps a retirement reservation barrier to the declared Action failure', () =>
  Effect.gen(function* retirementReservationConflict() {
    const services = makeChangeCustomerPaymentTermsServices(
      persistenceContext(
        transactionReturning([row('PRESENT', state(3), 3)], [row('PAYMENT_TERM_RETIREMENT_RESERVED', null, 3)]),
      ),
      { resolveDefinitions: () => Effect.succeed([]) },
    );
    const failure = yield* Effect.flip(
      services.change(
        {
          changes: [
            {
              _tag: 'CLEAR_PREFERENCE',
              effectiveAt: '2026-10-01T00:00:00.000Z',
            },
          ],
          counterpartyRef,
          expectedRevision: 3,
          profileRef,
          reason: 'Clear preference',
        },
        actionContextFor(services),
      ),
    );
    expect(failure).toMatchObject({
      code: 'PAYMENT_TERM_RETIREMENT_RESERVED',
      retryable: false,
    });
  }),
);

it.effect('projects cancelled future entitlements out of historical governed reads', () =>
  Effect.gen(function* historicalRead() {
    const cancelled: CustomerPaymentTermsState = {
      entitlements: [
        {
          cancelledAt: '2026-09-01T00:00:00.000Z',
          effectiveFrom: '2026-10-01T00:00:00.000Z',
          entitlementRef,
          paymentTermRef,
          semanticRevisionId,
          status: 'CANCELLED',
        },
      ],
      preferences: [],
      profileRef,
      revision: 2,
    };
    const services = makeCustomerPaymentTermEntitlementReadServices(
      persistenceContext(transactionReturning([row('PRESENT', cancelled, 2)])),
    );
    const result = yield* services.read({
      asOf: '2026-12-01T00:00:00.000Z',
      authorizationSubject: { counterpartyRef, kind: 'COUNTERPARTY' },
      includeHistorical: true,
      profileRef,
    });
    expect(Predicate.isTagged(result, 'CUSTOMER_PAYMENT_TERMS')).toBe(true);
    if (Predicate.isTagged(result, 'CUSTOMER_PAYMENT_TERMS')) {
      expect(result).toMatchObject({
        currentEntitlements: [],
        state: { entitlements: [] },
      });
    }
  }),
);

it.effect('fails resolution closed when Customer Commerce Policy is absent', () =>
  Effect.gen(function* unavailablePolicy() {
    const services = makePaymentTermsResolutionServices(
      persistenceContext(transactionReturning([row('PRESENT', state(), 1)])),
      { catalog: { resolveDefinitions: () => Effect.succeed([]) } },
    );
    const failure = yield* Effect.flip(
      services.resolve({
        at: '2026-10-01T00:00:00.000Z',
        authorizationSubject: { counterpartyRef, kind: 'COUNTERPARTY' },
        profileRef,
        purchasingContext: {
          channelId: 'b2b-web',
          contextRevision: 'context-1',
          marketId: 'cz',
          sellingLegalEntityId: legalEntityId,
          storefrontId: 'main',
        },
      }),
    );
    expect(Schema.is(ReadHandlerUnavailable)(failure)).toBe(true);
    if (Schema.is(ReadHandlerUnavailable)(failure)) {
      expect(failure.reason).toContain('Customer Commerce Policy');
    }
  }),
);

it.effect('maps explicit owner revision rejection to a nonretryable Action incompatibility without persistence', () =>
  Effect.gen(function* explicitRevisionRejection() {
    const catalog = paymentTermCatalogPort('revision-conflict', () =>
      Effect.succeed({
        current: [],
        effectiveAt: '2026-10-01T00:00:00.000Z',
        observedAt: '2026-10-01T00:00:00.000Z',
        referenceOutcomes: [
          {
            actualCompatibilityId: currentDefinition().compatibilityId,
            actualSemanticRevisionId: semanticRevisionId,
            definition: currentDefinition(),
            expectedSemanticRevisionId: '99999999-9999-4999-8999-999999999999',
            kind: 'INCOMPATIBLE',
            requestedPaymentTermRef: paymentTermRef,
          },
        ],
        truncated: false,
      }),
    );
    const services = makeChangeCustomerPaymentTermsServices(
      persistenceContext(transactionReturning([row('PRESENT', state(), 1)])),
      catalog,
    );
    const failure = yield* Effect.flip(
      services.change(
        {
          changes: [
            {
              _tag: 'GRANT_ENTITLEMENT',
              effectiveFrom: '2026-10-01T00:00:00.000Z',
              entitlementRef,
              paymentTermRef,
              semanticRevisionId: '99999999-9999-4999-8999-999999999999',
            },
          ],
          counterpartyRef,
          expectedRevision: 1,
          profileRef,
          reason: 'Approved terms',
        },
        actionContextFor(services),
      ),
    );
    expect(failure).toMatchObject({ code: 'PAYMENT_TERM_INCOMPATIBLE', retryable: false });
  }),
);

it.effect(
  'returns the original finite schedule after a persisted explicit End without rewriting unknown legacy facts',
  () =>
    Effect.gen(function* originalScheduleRead() {
      const ended: CustomerPaymentTermsState = {
        ...state(),
        entitlements: [
          {
            effectiveFrom: '2026-10-01T00:00:00.000Z',
            effectiveTo: '2026-11-01T00:00:00.000Z',
            endedAt: '2026-11-01T00:00:00.000Z',
            entitlementRef,
            originalEffectiveTo: '2026-12-01T00:00:00.000Z',
            paymentTermRef,
            semanticRevisionId,
            status: 'ACTIVE',
          },
        ],
      };
      const services = makeCustomerPaymentTermEntitlementReadServices(
        persistenceContext(transactionReturning([row('PRESENT', ended, ended.revision)])),
      );
      const result = yield* services.read({
        asOf: '2026-11-01T00:00:00.000Z',
        authorizationSubject: { counterpartyRef, kind: 'COUNTERPARTY' },
        includeHistorical: true,
        profileRef,
      });
      expect(Predicate.isTagged(result, 'CUSTOMER_PAYMENT_TERMS')).toBe(true);
      if (Predicate.isTagged(result, 'CUSTOMER_PAYMENT_TERMS')) {
        expect(result.currentEntitlements).toHaveLength(0);
        expect(result.state.entitlements[0]).toEqual(ended.entitlements[0]);
      }
    }),
);

it.effect('retains unknown legacy provenance during historical projection and known-open original null', () =>
  Effect.gen(function* legacyScheduleRead() {
    const old = {
      effectiveFrom: '2026-10-01T00:00:00.000Z',
      effectiveTo: '2026-11-01T00:00:00.000Z',
      entitlementRef,
      paymentTermRef,
      semanticRevisionId,
      status: 'ACTIVE' as const,
    };
    const legacy = { ...state(), entitlements: [old] };
    const services = makeCustomerPaymentTermEntitlementReadServices(
      persistenceContext(transactionReturning([row('PRESENT', legacy, legacy.revision)])),
    );
    const result = yield* services.read({
      asOf: '2026-12-01T00:00:00.000Z',
      authorizationSubject: { counterpartyRef, kind: 'COUNTERPARTY' },
      includeHistorical: true,
      profileRef,
    });
    expect(Predicate.isTagged(result, 'CUSTOMER_PAYMENT_TERMS')).toBe(true);
    if (Predicate.isTagged(result, 'CUSTOMER_PAYMENT_TERMS')) {
      expect(result.state.entitlements[0]).toEqual(old);
      expect(result.state.entitlements[0]?.originalEffectiveTo).toBeUndefined();
      expect(result.state.entitlements[0]?.endedAt).toBeUndefined();
    }
  }),
);

const legacyFiniteState = (): CustomerPaymentTermsState => ({
  ...state(2),
  entitlements: [
    {
      effectiveFrom: '2030-01-01T00:00:00.000Z',
      effectiveTo: '2030-06-01T00:00:00.000Z',
      entitlementRef,
      paymentTermRef,
      semanticRevisionId,
      status: 'ACTIVE',
    },
  ],
});
const legacyRemoval = {
  counterpartyRef,
  effectiveAt: '2029-01-01T00:00:00.000Z',
  entitlementRef,
  expectedRevision: 2,
  profileRef,
  reason: 'Authorized retained intent cancellation',
} as const;
const originalIntent = {
  ...legacyFiniteState().entitlements[0],
  originalEffectiveTo: '2030-06-01T00:00:00.000Z',
  profileRef,
  revision: 2,
};

it.effect('cancels only the selected legacy finite grant using a scope-bound owner proof', () =>
  Effect.gen(function* provedLegacyIntent() {
    const legacy = legacyFiniteState();
    const cancelled: CustomerPaymentTermsState = {
      ...legacy,
      entitlements: legacy.entitlements.map((entry) => ({
        ...entry,
        cancelledAt: legacyRemoval.effectiveAt,
        originalEffectiveTo: entry.effectiveTo ?? null,
        status: 'CANCELLED' as const,
      })),
      revision: 3,
    };
    const invoked: unknown[] = [];
    const responses = [
      [row('PRESENT', legacy, 2)],
      [{ current_revision: 2, outcome: 'PROVED', payload: originalIntent }],
      [row('APPLIED', cancelled, 3)],
    ];
    let index = 0;
    const invoker: CustomerPaymentTermsScopedRoutineInvoker = {
      invoke: (routine, values) => {
        invoked.push({ name: routine.name, values });
        const response = responses[index] ?? [];
        index += 1;
        return Effect.forEach(
          response,
          (item) => Schema.decodeUnknownEffect(Schema.toType(routine.resultSchema))(item),
          {
            concurrency: 1,
          },
        ).pipe(Effect.orDie);
      },
    };
    const result = yield* paymentTermsPersistenceForTransaction(persistenceContext(invoker)).remove.remove(
      legacyRemoval,
      { actionInvocationId, scope },
    );
    expect(result).toMatchObject({ changed: true, removalKind: 'CANCELLED', state: cancelled });
    expect(invoked[1]).toEqual({
      name: 'resolve_legacy_payment_term_grant_intent_v1',
      values: [profileId, counterpartyId, entitlementId, 2],
    });
  }),
);

it.effect('keeps absent or ambiguous retained intent fail closed without persistence', () =>
  Effect.gen(function* absentLegacyIntent() {
    const services = paymentTermsPersistenceForTransaction(
      persistenceContext(
        transactionReturning(
          [row('PRESENT', legacyFiniteState(), 2)],
          [{ current_revision: 2, outcome: 'UNPROVED', payload: null }],
        ),
      ),
    );
    const failure = yield* services.remove.remove(legacyRemoval, { actionInvocationId, scope }).pipe(Effect.flip);
    expect(failure).toMatchObject({ code: 'REMOVAL_CONFLICT', retryable: false });
  }),
);

it.effect('rejects a mismatched historical grant projection instead of enriching the current row', () =>
  Effect.gen(function* mismatchedLegacyIntent() {
    for (const payload of [
      { ...originalIntent, revision: 3 },
      { ...originalIntent, profileRef: { ...profileRef, resourceId: counterpartyId } },
      { ...originalIntent, semanticRevisionId: actionInvocationId },
      { ...originalIntent, originalEffectiveTo: '2031-06-01T00:00:00.000Z' },
      { ...originalIntent, unexpected: true },
      { ...originalIntent, originalEffectiveTo: null },
    ]) {
      const services = paymentTermsPersistenceForTransaction(
        persistenceContext(
          transactionReturning(
            [row('PRESENT', legacyFiniteState(), 2)],
            [{ current_revision: 2, outcome: 'PROVED', payload }],
          ),
        ),
      );
      const failure = yield* services.remove.remove(legacyRemoval, { actionInvocationId, scope }).pipe(Effect.flip);
      expect(failure).toMatchObject({ code: 'PERSISTENCE_UNAVAILABLE', retryable: true });
    }
  }),
);

it.effect('keeps known finite cancellation independent of historical availability', () =>
  Effect.gen(function* knownLegacySkip() {
    const legacy = legacyFiniteState();
    const known: CustomerPaymentTermsState = {
      ...legacy,
      entitlements: legacy.entitlements.map((entry) => ({ ...entry, originalEffectiveTo: entry.effectiveTo ?? null })),
    };
    const cancelled: CustomerPaymentTermsState = {
      ...known,
      entitlements: known.entitlements.map((entry) => ({
        ...entry,
        cancelledAt: legacyRemoval.effectiveAt,
        status: 'CANCELLED' as const,
      })),
      revision: 3,
    };
    const services = paymentTermsPersistenceForTransaction(
      persistenceContext(transactionReturning([row('PRESENT', known, 2)], [row('APPLIED', cancelled, 3)])),
    );
    expect(yield* services.remove.remove(legacyRemoval, { actionInvocationId, scope })).toMatchObject({
      changed: true,
      state: cancelled,
    });
  }),
);

it.effect('retains lookup unavailability as retryable and native CAS changes as conflicts', () =>
  Effect.gen(function* unavailableLegacyIntent() {
    const failure = new ScopedRoutineInvocationError({
      code: 'scoped_routine_invocation_failed',
      constraint: Option.none(),
      ownerModuleKey: 'commerce.customer-context',
      postgresCode: Option.none(),
      reason: 'Unavailable',
      routineKey: 'payment-terms.resolve-legacy-grant-intent',
    });
    let calls = 0;
    const invoker: CustomerPaymentTermsScopedRoutineInvoker = {
      invoke: (routine) => {
        calls += 1;
        if (calls > 1) {
          return Effect.fail(failure);
        }
        return Effect.forEach([row('PRESENT', legacyFiniteState(), 2)], (item) =>
          Schema.decodeUnknownEffect(Schema.toType(routine.resultSchema))(item),
        ).pipe(Effect.orDie);
      },
    };
    const unavailable = yield* paymentTermsPersistenceForTransaction(persistenceContext(invoker))
      .remove.remove(legacyRemoval, { actionInvocationId, scope })
      .pipe(Effect.flip);
    expect(unavailable).toMatchObject({ code: 'PERSISTENCE_UNAVAILABLE', retryable: true });
    const conflict = yield* paymentTermsPersistenceForTransaction(
      persistenceContext(
        transactionReturning(
          [row('PRESENT', legacyFiniteState(), 2)],
          [{ current_revision: 3, outcome: 'REVISION_CONFLICT', payload: null }],
        ),
      ),
    )
      .remove.remove(legacyRemoval, { actionInvocationId, scope })
      .pipe(Effect.flip);
    expect(conflict).toMatchObject({ code: 'REVISION_CONFLICT', currentRevision: 3, retryable: false });
  }),
);

it.effect('customer and retail unchanged preferences commit without a Catalog request', () =>
  Effect.gen(function* unchangedPreferences() {
    const existing: CustomerPaymentTermsState = {
      entitlements: [
        {
          effectiveFrom: '2026-01-01T00:00:00.000Z',
          entitlementRef,
          paymentTermRef,
          semanticRevisionId,
          status: 'ACTIVE',
        },
      ],
      preferences: [{ effectiveFrom: '2026-10-01T00:00:00.000Z', paymentTermRef }],
      profileRef,
      revision: 1,
    };
    const change = { _tag: 'SET_PREFERENCE', effectiveFrom: '2026-10-01T00:00:00.000Z', paymentTermRef } as const;
    const customerPayload = {
      changes: [change],
      counterpartyRef,
      expectedRevision: 1,
      profileRef,
      reason: 'Existing preference',
    };
    const noCatalog = { resolveDefinitions: () => Effect.die('Unchanged preference must not call Catalog') };
    expect(customerChangeDefinitionRequests(existing, customerPayload)).toEqual([]);
    const customer = makeChangeCustomerPaymentTermsServices(
      persistenceContext(transactionReturning([row('PRESENT', existing, 1)], [row('UNCHANGED', existing, 1)])),
      noCatalog,
    );
    expect(yield* customer.change(customerPayload, actionContextFor(customer))).toEqual({
      changed: false,
      state: existing,
    });

    const retailRef = { ...profileRef, resourceType: 'commerce.customer-context.retail-customer-profile' as const };
    const retailState = { ...existing, profileRef: retailRef };
    const retailPayload = { change, expectedRevision: 1, profileRef: retailRef };
    expect(retailChangeDefinitionRequests(retailState, retailPayload)).toEqual([]);
    const retail = paymentTermsPersistenceForTransaction(
      persistenceContext(transactionReturning([row('PRESENT', retailState, 1)], [row('UNCHANGED', retailState, 1)])),
      { catalog: noCatalog },
    ).retailPreference;
    expect(
      yield* retail.changePreference(retailPayload, { actionInvocationId, legalEntityId, principalId, tenantId }),
    ).toEqual({ changed: false, state: retailState });
    expect(retailChangeDefinitionRequests(retailState, { ...retailPayload, expectedRevision: 2 })).toHaveLength(1);
    expect(retailChangeDefinitionRequests({ ...retailState, preferences: [] }, retailPayload)).toHaveLength(1);
  }),
);

it.effect('prepared Catalog evidence is restricted to the exact ordered selector and preserves failures', () =>
  Effect.gen(function* preparedSelector() {
    const request = [
      { at: '2026-10-01T00:00:00.000Z', expectedSemanticRevisionId: semanticRevisionId, paymentTermRef },
    ];
    const definitions = [currentDefinition()];
    const catalog = bindPreparedPaymentTermCatalog(request, Result.succeed(definitions));
    expect(yield* catalog.resolveDefinitions(request)).toEqual(definitions);
    const cause = new PaymentTermsDependencyUnavailable({
      code: 'payment_terms_dependency_unavailable',
      dependency: 'PAYMENT_TERM_CATALOG',
      reason: 'Catalog unavailable',
    });
    const unavailable = bindPreparedPaymentTermCatalog(request, Result.fail(cause));
    expect(yield* Effect.flip(unavailable.resolveDefinitions(request))).toBe(cause);
    for (const candidate of [
      [{ ...request[0], at: '2026-10-02T00:00:00.000Z' }],
      [{ ...request[0], expectedSemanticRevisionId: entitlementId }],
      [{ ...request[0], paymentTermRef: aliasPaymentTermRef }],
    ]) {
      const failure = yield* Effect.flip(catalog.resolveDefinitions(candidate));
      expect(failure).toMatchObject({
        code: 'payment_terms_dependency_unavailable',
        dependency: 'PAYMENT_TERM_CATALOG',
      });
    }
  }),
);

it.effect('snapshot loaders use the actual owner profile selectors and detect changed owner state', () =>
  Effect.gen(function* snapshotSelectors() {
    const observed: (readonly unknown[])[] = [];
    const transaction: CustomerPaymentTermsScopedRoutineInvoker = {
      invoke: (routine, values) => {
        observed.push(values);
        return Schema.decodeUnknownEffect(Schema.toType(routine.resultSchema))(row('PRESENT', state(), 1)).pipe(
          Effect.map((value) => [value]),
          Effect.orDie,
        );
      },
    };
    const customerPayload = {
      changes: [{ _tag: 'CLEAR_PREFERENCE' as const, effectiveAt: '2026-10-01T00:00:00.000Z' }],
      counterpartyRef,
      expectedRevision: 1,
      profileRef,
      reason: 'Clear',
    };
    const snapshot = yield* loadCustomerChangeSnapshot(transaction, scope, customerPayload);
    expect(observed[0]).toEqual([profileId, 'COUNTERPARTY', counterpartyId]);
    expect(paymentTermsSnapshotUnchanged(stableRevision(snapshot), snapshot)).toBe(true);
    expect(paymentTermsSnapshotUnchanged(stableRevision(snapshot), { ...snapshot, revision: 2 })).toBe(false);
    expect(
      paymentTermsSnapshotUnchanged(stableRevision(snapshot), {
        ...snapshot,
        preferences: [{ effectiveFrom: '2026-10-01T00:00:00.000Z', paymentTermRef }],
      }),
    ).toBe(false);
    const retailRef = { ...profileRef, resourceType: 'commerce.customer-context.retail-customer-profile' as const };
    yield* loadRetailChangeSnapshot(transaction, scope, {
      change: customerPayload.changes[0],
      expectedRevision: 1,
      profileRef: retailRef,
    });
    expect(observed[1]).toEqual([profileId, 'RETAIL', null]);
  }),
);
