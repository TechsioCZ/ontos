// @effect-diagnostics nodeBuiltinImport:off -- Checked-in migration security is the contract under test; expires: 2027-03-31.
import { readFile } from 'node:fs/promises';

import type { OperationalScope } from '@app/core-runtime';
import { ReadHandlerUnavailable } from '@app/core-runtime';
import type { CurrentPaymentTermsResponse } from '@app/payment-term-catalog-contracts/current-payment-terms';
import { Effect, Predicate, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import type { CustomerPaymentTermsState } from '../../shared/domain/payment-term-contracts.ts';
import { ProfileReconciliationOwnerVerificationRequestSchema } from '../../shared/actions/resolve-profile-reconciliation.ts';
import type { ChangeCustomerPaymentTermsServices } from '../../src/actions/change-customer-payment-terms.action.ts';
import type { CustomerPaymentTermsScopedRoutineInvoker } from '../../src/persistence/payment-term-persistence.ts';
import {
  makeChangeCustomerPaymentTermsServices,
  makeCustomerPaymentTermEntitlementReadServices,
  makePaymentTermAffectedUseAssessmentServices,
  makePaymentTermsResolutionServices,
  paymentTermsRoutineAllowlist,
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
  compatibleWith: ['customer-payment-terms.v1'],
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
    calculationRuleVersion: 1,
    calendarRule: 'CALENDAR_DAYS_UTC',
    days: 30,
    dueDateAnchor: 'INVOICE_ISSUED_AT',
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
      return Effect.forEach(response, (item) => Schema.decodeUnknownEffect(routine.resultSchema)(item), {
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
          (item) => Schema.decodeUnknownEffect(routine.resultSchema)(item),
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
        return Effect.forEach(response, (item) => Schema.decodeUnknownEffect(routine.resultSchema)(item), {
          concurrency: 1,
        }).pipe(Effect.orDie);
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

it.effect('grants runtime access only to the three audited routines', () =>
  Effect.gen(function* migrationSecurity() {
    const sql = yield* Effect.tryPromise(() =>
      readFile(
        new URL('../../drizzle/20260909112241_payment-entitlement-routines/migration.sql', import.meta.url),
        'utf-8',
      ),
    );
    expect(sql.match(/SECURITY DEFINER/gu)?.length).toBeGreaterThanOrEqual(4);
    expect(sql).toContain('SET search_path = pg_catalog, commerce_customer_context');
    expect(sql).toContain('REVOKE ALL ON FUNCTION "commerce_customer_context"."read_customer_payment_terms"');
    expect(sql.match(/GRANT EXECUTE ON FUNCTION/gu)?.length).toBe(3);
    expect(sql).toContain('GRANT EXECUTE ON FUNCTION "commerce_customer_context"."read_customer_payment_terms"');
    expect(sql).toContain('GRANT EXECUTE ON FUNCTION "commerce_customer_context"."persist_customer_payment_terms"');
    expect(sql).toContain(
      'GRANT EXECUTE ON FUNCTION "commerce_customer_context"."assess_payment_term_entitlement_use"(uuid, uuid, uuid[], timestamptz) TO "ontos_runtime"',
    );
    expect(sql).not.toContain('"assess_payment_term_entitlement_use"(uuid, uuid, text, timestamptz)');
    expect(sql).toContain('cardinality(p_payment_term_resource_ids) NOT BETWEEN 1 AND 200');
    expect(sql).toContain('entitlement.payment_term_resource_id = ANY(p_payment_term_resource_ids::text[])');
    expect(sql).toContain('v_action_invocation_id IS NULL');
    expect(sql).toContain('customer_payment_term_entitlements.effective_to IS DISTINCT FROM excluded.effective_to');
    expect(sql).not.toMatch(
      /GRANT EXECUTE ON FUNCTION[^;]+(?:assert_customer_payment_terms_scope|customer_payment_terms_state_json)/iu,
    );
    expect(sql).not.toMatch(/GRANT\s+(?:SELECT|INSERT|UPDATE|DELETE)\s+ON/iu);
  }),
);

it.effect('assesses every non-cancelled entitlement interval overlapping the retirement horizon', () =>
  Effect.gen(function* retirementHorizonAssessment() {
    const sql = yield* Effect.tryPromise(() =>
      readFile(
        new URL('../../drizzle/20260909144801_assess-future-payment-term-uses/migration.sql', import.meta.url),
        'utf-8',
      ),
    );
    expect(sql).toContain("entitlement.lifecycle IN ('ACTIVE', 'ENDED')");
    expect(sql).toContain('entitlement.effective_to IS NULL');
    expect(sql).toContain('entitlement.effective_to > p_effective_at');
    expect(sql).not.toContain('entitlement.effective_from <= p_effective_at');
    expect(sql).not.toContain("profile.lifecycle = 'ACTIVE'");
    expect(sql).not.toContain('INNER JOIN commerce_customer_context.customer_profiles');
    expect(sql).toContain('payment-term-entitlement-use-horizon');
    expect(sql).toContain(
      'GRANT EXECUTE ON FUNCTION "commerce_customer_context"."assess_payment_term_entitlement_use"(uuid, uuid, uuid[], timestamptz) TO "ontos_runtime"',
    );
  }),
);

it.effect('verifies local Payment Terms facts without transferring them during reconciliation', () =>
  Effect.gen(function* paymentTermsOwnerMigration() {
    const sql = yield* Effect.tryPromise(() =>
      readFile(
        new URL('../../drizzle/20260909152000_payment-terms-reconciliation-owner/migration.sql', import.meta.url),
        'utf-8',
      ),
    );
    expect(sql).toContain(
      'CREATE OR REPLACE FUNCTION "commerce_customer_context"."verify_payment_terms_reconciliation_owner"',
    );
    expect(sql).toContain('SECURITY DEFINER');
    expect(sql).toContain('FOR UPDATE OF entitlement');
    expect(sql).toContain('FOR UPDATE OF preference');
    expect(sql).toContain('v_non_survivor_current_preferences > 0');
    expect(sql).toContain('futureOverlapInventory');
    expect(sql).toContain(
      'REVOKE ALL ON FUNCTION "commerce_customer_context"."verify_payment_terms_reconciliation_owner"',
    );
    expect(sql).toContain(
      'GRANT EXECUTE ON FUNCTION "commerce_customer_context"."verify_payment_terms_reconciliation_owner"',
    );
    expect(sql).not.toMatch(/GRANT\s+(?:SELECT|INSERT|UPDATE|DELETE)\s+ON/iu);
  }),
);
