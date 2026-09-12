/* eslint-disable anti-slop/no-chained-type-assertions, typescript/no-unsafe-type-assertion -- The test harness decodes database-shaped fixture rows through each owner routine schema before exposing Core's private branded transaction capability; expires: 2027-03-31. */
import { ScopedRoutineInvocationError, TrustedPrincipalContextSchema } from '@app/core-runtime';
import type { ScopedRoutineDefinition, ScopedTransactionExecutor } from '@app/core-runtime';
import { Effect, Match, Option, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  changeCounterpartyPurchaseLimit,
  changePrincipalPurchaseLimitOverride,
  purchaseApprovalTriggerEvidenceSourceForTransaction,
  purchaseLimitEvaluationSourceForTransaction,
  purchaseLimitRoutineAllowlist,
  readCurrentPurchaseLimitPolicy,
  readCurrentPurchaseLimitPolicyState,
} from '../../src/persistence/purchase-limit-persistence.ts';
import { TriggerPurchaseApprovalPayloadSchema } from '../../shared/actions/trigger-purchase-approval.ts';
import { PurchaseApprovalDependencyUnavailableSchema } from '../../shared/domain/purchase-limit-approval-trigger.ts';
import {
  PurchaseLimitEvaluationContextSchema,
  PurchaseLimitEvaluationQuerySchema,
} from '../../shared/domain/purchase-limit-evaluation.ts';
import { PurchaseLimitEvaluationCurrentFactsSchema } from '../../shared/domain/purchase-limit-evaluation-currentness-port.ts';
import {
  PurchaseLimitDependencyUnavailableSchema,
  PurchaseLimitPolicyConflictSchema,
} from '../../shared/domain/purchase-limit-policy.ts';
import { ExactNonNegativeDecimalSchema } from '../../shared/domain/purchase-limit.ts';

const { readFileSync } = process.getBuiltinModule('node:fs');

const tenantId = '10000000-0000-4000-8000-000000000001';
const legalEntityId = '20000000-0000-4000-8000-000000000001';
const actorPrincipalId = '30000000-0000-4000-8000-000000000001';
const targetPrincipalId = '30000000-0000-4000-8000-000000000002';
const actionInvocationId = '40000000-0000-4000-8000-000000000001';
const amount100 = Schema.decodeUnknownSync(ExactNonNegativeDecimalSchema)('100');
const evaluationContext = {
  contextRevision: 'commerce-context-9',
  purchasingContext: {
    channelId: 'b2b-web',
    marketId: 'cz',
    sellingLegalEntityId: legalEntityId,
    storefrontId: 'akros-cz',
    tenantId,
  },
  requestCorrelation: 'purchase-limit-evaluation-9',
  requestedAt: '2026-09-09T10:05:00.000Z',
} as const;
const counterpartyRef = {
  moduleId: 'party.registry',
  resourceId: '50000000-0000-4000-8000-000000000001',
  resourceType: 'party.registry.counterparty',
  tenantId,
} as const;
const trustedPrincipal = Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
  authBindingId: '70000000-0000-4000-8000-000000000001',
  authContextRef: 'better-auth-session:purchase-limit-evaluation-test',
  authMethod: 'session',
  legalEntityId,
  principalId: targetPrincipalId,
  tenantId,
  trustedStorefrontId: evaluationContext.purchasingContext.storefrontId,
});
const evaluationScope = {
  ...trustedPrincipal,
  correlationId: 'purchase-limit-evaluation-test',
  legalEntityId,
  trustedStorefrontId: evaluationContext.purchasingContext.storefrontId,
} as const;
const currentCounterpartyRole = {
  managedLegalEntityId: legalEntityId,
  outcome: 'ELIGIBLE',
  roleResourceId: 'party-role:purchase-limit-test',
  roleResourceRevision: 'party-role-revision:1',
} as const;
const externalSourceRevisions = [
  {
    revision: 'customer-commerce-policy:4',
    source: 'customer-commerce-policy',
  },
  { revision: 'purchase-value-revision-9', source: 'purchase-proposal' },
  { revision: 'purchasing-profile:2', source: 'purchasing-profile' },
  { revision: 'storefront-context:5', source: 'storefront-context' },
] as const;

const transactionReturning = (rows: readonly object[]) =>
  // SAFETY: The harness decodes every fixture with the invoked routine schema before exposing the
  // private Core brand; persistence under test only consumes `invoke`.
  ({
    invoke: (routine: ScopedRoutineDefinition) =>
      Effect.succeed(Schema.decodeUnknownSync(Schema.Array(routine.resultSchema))(rows)),
  }) as unknown as ScopedTransactionExecutor;

// SAFETY: This failure harness implements the only capability exercised by the persistence read.
const failingTransaction = {
  invoke: () =>
    Effect.fail(
      new ScopedRoutineInvocationError({
        code: 'scoped_routine_invocation_failed',
        constraint: Option.none(),
        ownerModuleKey: 'commerce.customer-context',
        postgresCode: Option.none(),
        reason: 'sanitized',
        routineKey: 'purchase-limit.read-current-policies',
      }),
    ),
} as unknown as ScopedTransactionExecutor;

interface MutationRowInput {
  readonly current_amount: null | string;
  readonly current_currency_code: null | string;
  readonly current_policy_id: null | string;
  readonly current_policy_kind: 'MONETARY_LIMIT' | 'UNLIMITED' | null;
  readonly current_recorded_at: null | string;
  readonly current_revision: null | number;
  readonly outcome: 'APPLIED' | 'PROFILE_NOT_FOUND' | 'REVISION_CONFLICT' | 'UNCHANGED';
  readonly previous_amount: null | string;
  readonly previous_currency_code: null | string;
  readonly previous_policy_id: null | string;
  readonly previous_policy_kind: 'MONETARY_LIMIT' | 'UNLIMITED' | null;
  readonly previous_recorded_at: null | string;
  readonly previous_revision: null | number;
}

const mutationRow = (overrides: Partial<MutationRowInput> = {}): MutationRowInput => ({
  current_amount: '100.000000000000000000',
  current_currency_code: 'CZK',
  current_policy_id: '60000000-0000-4000-8000-000000000001',
  current_policy_kind: 'MONETARY_LIMIT',
  current_recorded_at: '2026-09-09T10:00:00.000Z',
  current_revision: 2,
  outcome: 'APPLIED',
  previous_amount: null,
  previous_currency_code: null,
  previous_policy_id: null,
  previous_policy_kind: null,
  previous_recorded_at: null,
  previous_revision: null,
  ...overrides,
});

it('declares immutable exact routine allowlist entries with Core-injected scope first', () => {
  expect(purchaseLimitRoutineAllowlist.map(({ name, routineKey }) => [name, routineKey])).toEqual([
    ['read_current_purchase_proposal_revision', 'purchase-approval.read-current-proposal'],
    ['read_purchase_limit_policies', 'purchase-limit.read-current-policies'],
    ['change_purchase_limit_policy', 'purchase-limit.change-policy'],
  ]);
  for (const routine of purchaseLimitRoutineAllowlist) {
    expect(Object.isFrozen(routine)).toBe(true);
    expect(routine.ownerModuleKey).toBe('commerce.customer-context');
    expect(routine.parameters.slice(0, 2)).toEqual([
      { source: 'tenantId', type: 'uuid' },
      { source: 'legalEntityId', type: 'uuid' },
    ]);
  }
});

it.effect('maps Current default and exact Principal override rows with override precedence', () =>
  Effect.gen(function* readOverride() {
    const result = yield* readCurrentPurchaseLimitPolicy(
      transactionReturning([
        {
          amount: '100.000000000000000000',
          currency_code: 'CZK',
          outcome: 'PRESENT',
          policy_id: '60000000-0000-4000-8000-000000000001',
          policy_kind: 'MONETARY_LIMIT',
          recorded_at: '2026-09-09T10:00:00.000Z',
          revision: 1,
          source: 'COUNTERPARTY_DEFAULT',
          source_revision: 'counterparty-policy:1',
        },
        {
          amount: null,
          currency_code: null,
          outcome: 'PRESENT',
          policy_id: '60000000-0000-4000-8000-000000000002',
          policy_kind: 'UNLIMITED',
          recorded_at: '2026-09-09T10:01:00.000Z',
          revision: 2,
          source: 'PRINCIPAL_OVERRIDE',
          source_revision: 'principal-override:2',
        },
      ]),
      {
        counterpartyRef,
        principalRef: { principalId: targetPrincipalId, tenantId },
        tenantId,
      },
    );
    const effective = Match.value(result).pipe(
      Match.tag('EFFECTIVE_POLICY', ({ effectivePolicy }) =>
        Match.value(effectivePolicy.policy).pipe(
          Match.tag('UNLIMITED', () => ({
            kind: 'UNLIMITED',
            revision: effectivePolicy.revision,
            source: effectivePolicy.source,
          })),
          Match.tag('MONETARY_LIMIT', () => null),
          Match.exhaustive,
        ),
      ),
      Match.tag('INCONSISTENT_POLICY', () => null),
      Match.tag('NO_EFFECTIVE_POLICY', () => null),
      Match.exhaustive,
    );
    expect(effective).toEqual({
      kind: 'UNLIMITED',
      revision: 2,
      source: 'PRINCIPAL_OVERRIDE',
    });
  }),
);

it.effect('treats a Current clear marker as absence rather than UNLIMITED', () =>
  Effect.gen(function* readCleared() {
    const result = yield* readCurrentPurchaseLimitPolicy(
      transactionReturning([
        {
          amount: null,
          currency_code: null,
          outcome: 'PRESENT',
          policy_id: '60000000-0000-4000-8000-000000000003',
          policy_kind: 'CLEARED',
          recorded_at: '2026-09-09T10:02:00.000Z',
          revision: 3,
          source: 'COUNTERPARTY_DEFAULT',
          source_revision: 'counterparty-policy:3',
        },
      ]),
      {
        counterpartyRef,
        principalRef: { principalId: targetPrincipalId, tenantId },
        tenantId,
      },
    );
    const hasEffectivePolicy = Match.value(result).pipe(
      Match.tag('EFFECTIVE_POLICY', () => true),
      Match.tag('INCONSISTENT_POLICY', () => true),
      Match.tag('NO_EFFECTIVE_POLICY', () => false),
      Match.exhaustive,
    );
    expect(hasEffectivePolicy).toBe(false);
  }),
);

it.effect('preserves clear and explicit absence revisions for deterministic Currentness', () =>
  Effect.gen(function* policyCurrentness() {
    const state = yield* readCurrentPurchaseLimitPolicyState(
      transactionReturning([
        {
          amount: null,
          currency_code: null,
          outcome: 'PRESENT',
          policy_id: '60000000-0000-4000-8000-000000000003',
          policy_kind: 'CLEARED',
          recorded_at: '2026-09-09T10:02:00.000Z',
          revision: 3,
          source: 'COUNTERPARTY_DEFAULT',
          source_revision: 'counterparty-policy:3',
        },
      ]),
      {
        counterpartyRef,
        principalRef: { principalId: targetPrincipalId, tenantId },
        tenantId,
      },
    );
    expect(state.sourceRevisions).toEqual([
      { revision: 'counterparty-policy:3', source: 'counterparty-policy' },
      { revision: 'principal-override:absent', source: 'principal-override' },
    ]);
  }),
);

it.effect('rejects a PrincipalRef from another Tenant before invoking persistence', () =>
  Effect.gen(function* rejectCrossTenantPrincipal() {
    let invocations = 0;
    // SAFETY: The subject-scope guard must return before this test double's only method is reached.
    const unexpectedTransaction = {
      invoke: () => {
        invocations += 1;
        return Effect.succeed([]);
      },
    } as unknown as ScopedTransactionExecutor;
    const error = yield* Effect.flip(
      readCurrentPurchaseLimitPolicy(unexpectedTransaction, {
        counterpartyRef,
        principalRef: {
          principalId: targetPrincipalId,
          tenantId: '10000000-0000-4000-8000-000000000099',
        },
        tenantId,
      }),
    );
    expect(invocations).toBe(0);
    expect(Schema.is(PurchaseLimitDependencyUnavailableSchema)(error)).toBe(true);
  }),
);

it.effect('maps exact numeric storage canonically and preserves a material mutation result', () =>
  Effect.gen(function* changedDefault() {
    const result = yield* changeCounterpartyPurchaseLimit(transactionReturning([mutationRow()]), {
      actionInvocationId,
      actorPrincipalId,
      change: {
        _tag: 'SET',
        policy: {
          _tag: 'MONETARY_LIMIT',
          limit: { amount: amount100, currency: 'CZK' },
        },
      },
      counterpartyRef,
      expectedRevision: null,
      reason: 'Signed purchasing authority update',
    });
    expect(result).toMatchObject({
      currentPolicy: {
        policy: {
          _tag: 'MONETARY_LIMIT',
          limit: { amount: '100', currency: 'CZK' },
        },
        revision: 2,
      },
      previousPolicy: null,
      status: 'CHANGED',
    });
  }),
);

it.effect('maps a serialized CAS miss to the typed conflict and exposes only logical Current revision', () =>
  Effect.gen(function* conflict() {
    const error = yield* Effect.flip(
      changePrincipalPurchaseLimitOverride(transactionReturning([mutationRow({ outcome: 'REVISION_CONFLICT' })]), {
        actionInvocationId,
        actorPrincipalId,
        change: { _tag: 'CLEAR' },
        counterpartyRef,
        expectedRevision: 1,
        principalRef: { principalId: targetPrincipalId, tenantId },
        reason: 'Remove individual override',
      }),
    );
    if (!Schema.is(PurchaseLimitPolicyConflictSchema)(error)) {
      throw new Error('Expected a Purchase Limit policy conflict');
    }
    expect(error.code).toBe('purchase_limit_policy_conflict');
    expect(error.currentRevision).toBe(2);
  }),
);

it.effect('maps Core routine failure to a sanitized typed dependency failure', () =>
  Effect.gen(function* unavailable() {
    const error = yield* Effect.flip(
      readCurrentPurchaseLimitPolicy(failingTransaction, {
        counterpartyRef,
        principalRef: { principalId: targetPrincipalId, tenantId },
        tenantId,
      }),
    );
    if (!Schema.is(PurchaseLimitDependencyUnavailableSchema)(error)) {
      throw new Error('Expected a Purchase Limit dependency failure');
    }
    expect(error.code).toBe('purchase_limit_dependency_unavailable');
    expect(error.dependency).toBe('commerce.customer-context.purchase-limit-policy');
    expect(error.reason).toContain('purchase-limit.read-current-policies');
    expect(error.reason).not.toContain('SQL');
  }),
);

it.effect('composes trusted Current facts with both owner-local policy revisions', () =>
  Effect.gen(function* composeEvaluationSource() {
    const authoritativePurchaseValue = {
      monetaryAmount: { amount: amount100, currency: 'CZK' },
      roundingRuleRevision: 'pricing-rounding-4',
      sourceRef: 'purchase-value-9',
      sourceRevision: 'purchase-value-revision-9',
    } as const;
    const source = purchaseLimitEvaluationSourceForTransaction(
      transactionReturning([
        {
          amount: '150.000000000',
          currency_code: 'CZK',
          outcome: 'PRESENT',
          policy_id: '60000000-0000-4000-8000-000000000001',
          policy_kind: 'MONETARY_LIMIT',
          recorded_at: '2026-09-09T10:00:00.000Z',
          revision: 1,
          source: 'COUNTERPARTY_DEFAULT',
          source_revision: 'counterparty-policy:1',
        },
      ]),
      evaluationScope,
      {
        resolveCurrent: ({ scope }) => {
          expect(scope.storefrontId).toBe(evaluationContext.purchasingContext.storefrontId);
          return Effect.succeed(
            Schema.decodeUnknownSync(PurchaseLimitEvaluationCurrentFactsSchema)({
              channelId: evaluationContext.purchasingContext.channelId,
              contextRevision: evaluationContext.contextRevision,
              currentSourceRevisions: externalSourceRevisions,
              marketId: evaluationContext.purchasingContext.marketId,
              purchaseValue: authoritativePurchaseValue,
            }),
          );
        },
      },
    );
    const query = Schema.decodeUnknownSync(PurchaseLimitEvaluationQuerySchema)({
      counterpartyRef,
      expectedSourceRevisions: [
        { revision: 'counterparty-policy:1', source: 'counterparty-policy' },
        ...externalSourceRevisions,
        {
          revision: 'principal-override:absent',
          source: 'principal-override',
        },
      ],
      purchaseValue: {
        ...authoritativePurchaseValue,
        monetaryAmount: { amount: '999', currency: 'CZK' },
      },
      storefrontId: evaluationContext.purchasingContext.storefrontId,
    });
    const input = yield* source.loadCurrent({
      principalId: targetPrincipalId,
      query,
    });
    expect(input.purchaseValue.monetaryAmount.amount).toBe('100');
    expect(input.currentSourceRevisions).toEqual([
      ...externalSourceRevisions,
      { revision: 'counterparty-policy:1', source: 'counterparty-policy' },
      { revision: 'principal-override:absent', source: 'principal-override' },
    ]);
  }),
);

it.effect('fails closed with a typed dependency outcome for cross-currency Launch inputs', () =>
  Effect.gen(function* firstCrossCurrencyEvaluation() {
    const authoritativePurchaseValue = {
      monetaryAmount: { amount: amount100, currency: 'EUR' },
      roundingRuleRevision: 'pricing-rounding-4',
      sourceRef: 'purchase-value-9',
      sourceRevision: 'purchase-value-revision-9',
    } as const;
    const source = purchaseLimitEvaluationSourceForTransaction(
      transactionReturning([
        {
          amount: '150.000000000',
          currency_code: 'CZK',
          outcome: 'PRESENT',
          policy_id: '60000000-0000-4000-8000-000000000001',
          policy_kind: 'MONETARY_LIMIT',
          recorded_at: '2026-09-09T10:00:00.000Z',
          revision: 1,
          source: 'COUNTERPARTY_DEFAULT',
          source_revision: 'counterparty-policy:1',
        },
      ]),
      evaluationScope,
      {
        resolveCurrent: () =>
          Effect.succeed(
            Schema.decodeUnknownSync(PurchaseLimitEvaluationCurrentFactsSchema)({
              channelId: evaluationContext.purchasingContext.channelId,
              contextRevision: evaluationContext.contextRevision,
              currentSourceRevisions: externalSourceRevisions,
              marketId: evaluationContext.purchasingContext.marketId,
              purchaseValue: authoritativePurchaseValue,
            }),
          ),
      },
    );
    const query = Schema.decodeUnknownSync(PurchaseLimitEvaluationQuerySchema)({
      counterpartyRef,
      expectedSourceRevisions: [
        { revision: 'counterparty-policy:1', source: 'counterparty-policy' },
        ...externalSourceRevisions,
        {
          revision: 'principal-override:absent',
          source: 'principal-override',
        },
      ],
      purchaseValue: authoritativePurchaseValue,
      storefrontId: evaluationContext.purchasingContext.storefrontId,
    });
    const failure = yield* Effect.flip(
      source.loadCurrent({
        principalId: targetPrincipalId,
        query,
      }),
    );
    if (!Schema.is(PurchaseLimitDependencyUnavailableSchema)(failure)) {
      throw new Error('Expected a typed Purchase Limit dependency failure');
    }
    expect(failure.dependency).toBe('commerce.customer-context.purchase-limit-cross-currency');
    expect(failure.reason).toContain('Current purpose-specific comparable Purchase Value is unavailable');
  }),
);

it.effect('re-reads exact profile and proposal evidence for the approval trigger', () =>
  Effect.gen(function* readApprovalEvidence() {
    const profileId = '90000000-0000-4000-8000-000000000001';
    const proposalValue = {
      monetaryAmount: { amount: amount100, currency: 'CZK' },
      roundingRuleRevision: 'pricing-rounding-4',
      sourceRef: 'purchase-proposal:90000000-0000-4000-8000-000000000002',
      sourceRevision: 'proposal:9',
    } as const;
    const approvalExternalRevisions = [
      {
        revision: 'customer-commerce-policy:4',
        source: 'customer-commerce-policy',
      },
      { revision: proposalValue.sourceRevision, source: 'purchase-proposal' },
      { revision: '2', source: 'purchasing-profile' },
      { revision: 'storefront-context:5', source: 'storefront-context' },
    ] as const;
    const profileRef = {
      kind: 'COUNTERPARTY',
      moduleId: 'commerce.customer-context',
      resourceId: profileId,
      resourceType: 'commerce.customer-context.counterparty-purchasing-profile',
      tenantId,
    } as const;
    const payload = Schema.decodeUnknownSync(TriggerPurchaseApprovalPayloadSchema)({
      counterpartyRef,
      expectedSourceRevisions: [
        {
          revision: 'counterparty-policy:absent',
          source: 'counterparty-policy',
        },
        ...approvalExternalRevisions,
        {
          revision: 'principal-override:absent',
          source: 'principal-override',
        },
      ],
      profileRef,
      proposalRevisionRef: proposalValue.sourceRef,
      purchaseValue: proposalValue,
      storefrontId: evaluationScope.trustedStorefrontId,
    });
    const trustedContext = Schema.decodeUnknownSync(PurchaseLimitEvaluationContextSchema)({
      counterpartyRef,
      principalId: evaluationScope.principalId,
      sellingLegalEntityId: evaluationScope.legalEntityId,
      storefrontId: evaluationScope.trustedStorefrontId,
    });
    const invokedRoutines: string[] = [];
    // SAFETY: The harness schema-decodes the fixture with the invoked routine's declared result
    // schema before exposing the only private transaction capability exercised by this adapter.
    const transaction = {
      invoke: (routine: ScopedRoutineDefinition) => {
        invokedRoutines.push(routine.name);
        return Effect.succeed(
          Schema.decodeUnknownSync(Schema.Array(routine.resultSchema))(
            routine.name === 'read_profile_trading_gate'
              ? [
                  {
                    outcome: 'PROFILE_AVAILABLE',
                    payload: {
                      createdAt: '2026-09-09T09:00:00.000Z',
                      profileId,
                      profileKind: 'COUNTERPARTY',
                      revision: 2,
                      state: 'ACTIVE',
                      subject: {
                        counterpartyResourceId: counterpartyRef.resourceId,
                        counterpartyResourceRevision: 'counterparty:7',
                        customerRoleResourceId: null,
                        customerRoleResourceRevision: null,
                        kind: 'COUNTERPARTY',
                      },
                      updatedAt: '2026-09-09T10:00:00.000Z',
                    },
                  },
                ]
              : [],
          ),
        );
      },
    } as unknown as ScopedTransactionExecutor;
    const evidenceSource = purchaseApprovalTriggerEvidenceSourceForTransaction(
      transaction,
      evaluationScope,
      {
        resolveCurrent: () =>
          Effect.succeed(
            Schema.decodeUnknownSync(PurchaseLimitEvaluationCurrentFactsSchema)({
              channelId: evaluationContext.purchasingContext.channelId,
              contextRevision: evaluationContext.contextRevision,
              currentSourceRevisions: approvalExternalRevisions,
              marketId: evaluationContext.purchasingContext.marketId,
              purchaseValue: proposalValue,
            }),
          ),
      },
      {
        resolveCounterpartyRole: () => Effect.succeed(currentCounterpartyRole),
      },
    );
    const evidence = yield* evidenceSource.loadCurrent({
      payload,
      trustedContext,
    });
    expect(invokedRoutines).toHaveLength(2);
    expect(invokedRoutines).toContain('read_profile_trading_gate');
    expect(invokedRoutines).toContain('read_purchase_limit_policies');
    expect(evidence.currentSourceRevisions).toEqual([
      ...approvalExternalRevisions,
      {
        revision: 'counterparty-policy:absent',
        source: 'counterparty-policy',
      },
      { revision: 'principal-override:absent', source: 'principal-override' },
    ]);
    expect(evidence.profileEvidence).toMatchObject({
      counterpartyRef,
      gate: { canAcceptNewOrder: true, outcome: 'ACTIVE' },
      profileRef,
      revision: 2,
      sourceRevision: '2',
    });
    expect(evidence.proposalEvidence).toMatchObject({
      proposalRevisionRef: proposalValue.sourceRef,
      purchaseValue: proposalValue,
      revision: proposalValue.sourceRevision,
      state: 'CURRENT',
    });
  }),
);

it.effect('rejects approval evidence when the profile revision is not owner-current', () =>
  Effect.gen(function* rejectStaleProfileEvidence() {
    const profileId = '90000000-0000-4000-8000-000000000003';
    const proposalValue = {
      monetaryAmount: { amount: amount100, currency: 'CZK' },
      roundingRuleRevision: 'pricing-rounding-4',
      sourceRef: 'purchase-proposal:90000000-0000-4000-8000-000000000004',
      sourceRevision: 'proposal:10',
    } as const;
    const profileRef = {
      kind: 'COUNTERPARTY',
      moduleId: 'commerce.customer-context',
      resourceId: profileId,
      resourceType: 'commerce.customer-context.counterparty-purchasing-profile',
      tenantId,
    } as const;
    const expectedSourceRevisions = [
      {
        revision: 'counterparty-policy:absent',
        source: 'counterparty-policy',
      },
      {
        revision: 'customer-commerce-policy:4',
        source: 'customer-commerce-policy',
      },
      { revision: 'principal-override:absent', source: 'principal-override' },
      { revision: proposalValue.sourceRevision, source: 'purchase-proposal' },
      { revision: 'stale-profile-revision', source: 'purchasing-profile' },
      { revision: 'storefront-context:5', source: 'storefront-context' },
    ] as const;
    const payload = Schema.decodeUnknownSync(TriggerPurchaseApprovalPayloadSchema)({
      counterpartyRef,
      expectedSourceRevisions,
      profileRef,
      proposalRevisionRef: proposalValue.sourceRef,
      purchaseValue: proposalValue,
      storefrontId: evaluationScope.trustedStorefrontId,
    });
    const trustedContext = Schema.decodeUnknownSync(PurchaseLimitEvaluationContextSchema)({
      counterpartyRef,
      principalId: evaluationScope.principalId,
      sellingLegalEntityId: evaluationScope.legalEntityId,
      storefrontId: evaluationScope.trustedStorefrontId,
    });
    // SAFETY: The harness schema-decodes the fixture with the invoked routine's declared result
    // schema before exposing the only private transaction capability exercised by this adapter.
    const transaction = {
      invoke: (routine: ScopedRoutineDefinition) =>
        Effect.succeed(
          Schema.decodeUnknownSync(Schema.Array(routine.resultSchema))(
            routine.name === 'read_profile_trading_gate'
              ? [
                  {
                    outcome: 'PROFILE_AVAILABLE',
                    payload: {
                      createdAt: '2026-09-09T09:00:00.000Z',
                      profileId,
                      profileKind: 'COUNTERPARTY',
                      revision: 2,
                      state: 'ACTIVE',
                      subject: {
                        counterpartyResourceId: counterpartyRef.resourceId,
                        counterpartyResourceRevision: 'counterparty:7',
                        customerRoleResourceId: null,
                        customerRoleResourceRevision: null,
                        kind: 'COUNTERPARTY',
                      },
                      updatedAt: '2026-09-09T10:00:00.000Z',
                    },
                  },
                ]
              : [],
          ),
        ),
    } as unknown as ScopedTransactionExecutor;
    const evidenceSource = purchaseApprovalTriggerEvidenceSourceForTransaction(
      transaction,
      evaluationScope,
      {
        resolveCurrent: () =>
          Effect.succeed(
            Schema.decodeUnknownSync(PurchaseLimitEvaluationCurrentFactsSchema)({
              channelId: evaluationContext.purchasingContext.channelId,
              contextRevision: evaluationContext.contextRevision,
              currentSourceRevisions: expectedSourceRevisions.filter(
                ({ source: candidateSource }) =>
                  candidateSource !== 'counterparty-policy' && candidateSource !== 'principal-override',
              ),
              marketId: evaluationContext.purchasingContext.marketId,
              purchaseValue: proposalValue,
            }),
          ),
      },
      {
        resolveCounterpartyRole: () => Effect.succeed(currentCounterpartyRole),
      },
    );
    const failure = yield* Effect.flip(evidenceSource.loadCurrent({ payload, trustedContext }));
    if (!Schema.is(PurchaseApprovalDependencyUnavailableSchema)(failure)) {
      throw new Error('Expected a typed Purchase Approval dependency failure');
    }
    expect(failure.dependency).toBe('CUSTOMER_PROFILE');
    expect(failure.reason).toContain('owner revision');
  }),
);

it.effect('rejects an external Currentness provider claiming owner-local revision sources', () =>
  Effect.gen(function* rejectRevisionCollision() {
    const source = purchaseLimitEvaluationSourceForTransaction(transactionReturning([]), evaluationScope, {
      resolveCurrent: () =>
        Effect.succeed(
          Schema.decodeUnknownSync(PurchaseLimitEvaluationCurrentFactsSchema)({
            channelId: evaluationContext.purchasingContext.channelId,
            contextRevision: evaluationContext.contextRevision,
            currentSourceRevisions: [
              ...externalSourceRevisions,
              {
                revision: 'counterparty-policy:forged',
                source: 'counterparty-policy',
              },
            ],
            marketId: evaluationContext.purchasingContext.marketId,
            purchaseValue: {
              monetaryAmount: { amount: amount100, currency: 'CZK' },
              roundingRuleRevision: 'pricing-rounding-4',
              sourceRef: 'purchase-value-9',
              sourceRevision: 'purchase-value-revision-9',
            },
          }),
        ),
    });
    const query = Schema.decodeUnknownSync(PurchaseLimitEvaluationQuerySchema)({
      counterpartyRef,
      expectedSourceRevisions: [
        {
          revision: 'counterparty-policy:absent',
          source: 'counterparty-policy',
        },
        ...externalSourceRevisions,
        {
          revision: 'principal-override:absent',
          source: 'principal-override',
        },
      ],
      purchaseValue: {
        monetaryAmount: { amount: amount100, currency: 'CZK' },
        roundingRuleRevision: 'pricing-rounding-4',
        sourceRef: 'purchase-value-9',
        sourceRevision: 'purchase-value-revision-9',
      },
      storefrontId: evaluationContext.purchasingContext.storefrontId,
    });
    const failure = yield* Effect.flip(source.loadCurrent({ principalId: targetPrincipalId, query }));
    expect(Schema.is(PurchaseLimitDependencyUnavailableSchema)(failure)).toBe(true);
    expect(failure.reason).toContain('claimed owner-local sources');
  }),
);

it('hardens the migration around scope, races, tombstones, and exact EXECUTE-only grants', () => {
  const migration = readFileSync(
    new URL('../../drizzle/20260909112249_purchase-limit-routines/migration.sql', import.meta.url),
    'utf-8',
  );
  const correctiveMigration = readFileSync(
    new URL('../../drizzle/20260909123358_add_customer_group_revision_description/migration.sql', import.meta.url),
    'utf-8',
  );
  expect(migration.match(/SECURITY DEFINER/gu)).toHaveLength(2);
  expect(migration.match(/SET search_path = pg_catalog, commerce_customer_context/gu)).toHaveLength(2);
  expect(migration.match(/current_setting\('ontos\.tenant_id', true\)/gu)).toHaveLength(2);
  expect(migration.match(/current_setting\('ontos\.legal_entity_id', true\)/gu)).toHaveLength(2);
  expect(migration).toContain('FOR UPDATE;');
  expect(correctiveMigration).toContain("\"policy_kind\" in ('UNLIMITED', 'CLEARED')");
  expect(correctiveMigration).toContain('SET DATA TYPE numeric(38,9)');
  expect(correctiveMigration).toContain('amount" <> trunc("amount", 9)');
  expect(migration).toContain('policy.action_invocation_id = p_action_invocation_id');
  expect(migration).toContain('p_expected_revision IS DISTINCT FROM v_logical_revision');
  expect(migration).toContain('REVOKE ALL ON FUNCTION');
  expect(migration.match(/GRANT EXECUTE ON FUNCTION/gu)).toHaveLength(2);
  expect(migration).not.toMatch(/GRANT\s+(?:SELECT|INSERT|UPDATE|DELETE|ALL)\s+ON\s+(?:TABLE|ALL TABLES)/u);
});
