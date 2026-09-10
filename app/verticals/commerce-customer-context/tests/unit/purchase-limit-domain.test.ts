import { expect, it } from 'effect-rstest';
import { DateTime, Effect, Match, Option, Schema } from 'effect';
import {
  PurchaseApprovalCurrentnessIndeterminateSchema,
  PurchaseApprovalDependencyUnavailableSchema,
  PurchaseApprovalSubmission,
  triggerPurchaseApproval,
} from '../../shared/domain/purchase-limit-approval-trigger.ts';
import {
  PurchaseLimitEvaluationContextSchema,
  PurchaseLimitComparableValueSchema,
  evaluatePurchaseLimit,
  findStalePurchaseLimitSources,
  resolveComparablePurchaseValue,
} from '../../shared/domain/purchase-limit-evaluation.ts';
import type { PurchaseLimitEvaluationInput } from '../../shared/domain/purchase-limit-evaluation.ts';
import { PurchaseLimitFx } from '../../shared/domain/purchase-limit-fx-port.ts';
import type { PurchaseLimitFxPort } from '../../shared/domain/purchase-limit-fx-port.ts';
import {
  PurchaseLimitPolicySchema,
  PurchaseLimitPolicySnapshotSchema,
  resolveEffectivePurchaseLimitPolicy,
} from '../../shared/domain/purchase-limit-policy.ts';
import type {
  EffectivePurchaseLimitPolicy,
  EffectivePurchaseLimitPolicyResult,
  PurchaseLimitPolicy,
  PurchaseLimitPolicySnapshot,
  PurchaseLimitPolicySubject,
} from '../../shared/domain/purchase-limit-policy.ts';
import {
  compareExactDecimals,
  ExactNonNegativeDecimalSchema,
  PurchaseValueSchema,
} from '../../shared/domain/purchase-limit.ts';
import type { PurchaseValue } from '../../shared/domain/purchase-limit.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const principalId = '20000000-0000-4000-8000-000000000001';
const counterpartyRef = {
  moduleId: 'party.registry',
  resourceId: '30000000-0000-4000-8000-000000000001',
  resourceType: 'party.registry.counterparty',
  tenantId,
} as const;
const otherCounterpartyRef = {
  ...counterpartyRef,
  resourceId: '30000000-0000-4000-8000-000000000002',
} as const;
const decidedAtText = '2026-09-09T10:00:00.000Z';
const decidedAt = DateTime.makeUnsafe(decidedAtText);
const sellingLegalEntityId = Schema.decodeUnknownSync(
  PurchaseLimitEvaluationContextSchema.fields.sellingLegalEntityId,
)('50000000-0000-4000-8000-000000000001');
const storefrontId = Schema.decodeUnknownSync(
  PurchaseLimitEvaluationContextSchema.fields.storefrontId,
)('storefront:akros-b2b');
const evaluationContext = {
  counterpartyRef,
  principalId,
  sellingLegalEntityId,
  storefrontId,
};
const profileEvidence = {
  counterpartyRef,
  evaluatedAt: decidedAt,
  evaluationContext,
  gate: { canAcceptNewOrder: true, outcome: 'ACTIVE' as const },
  profileRef: {
    kind: 'COUNTERPARTY' as const,
    moduleId: 'commerce.customer-context' as const,
    resourceId: '60000000-0000-4000-8000-000000000001',
    resourceType: 'commerce.customer-context.counterparty-purchasing-profile' as const,
    tenantId,
  },
  revision: 1,
  sourceRevision: '1',
};
const revisions = [
  { revision: 'counterparty-policy:1', source: 'counterparty-policy' },
  { revision: 'customer-commerce-policy:1', source: 'customer-commerce-policy' },
  { revision: 'principal-override:none:1', source: 'principal-override' },
  { revision: 'proposal:1', source: 'purchase-proposal' },
  { revision: '1', source: 'purchasing-profile' },
  { revision: 'storefront:1', source: 'storefront-context' },
  { revision: 'comparable-value:7', source: 'comparable-value' },
] as const;

const purchaseValue = (
  amount: string,
  currency = 'CZK',
  sourceRevision = 'proposal:1',
): PurchaseValue =>
  Schema.decodeUnknownSync(PurchaseValueSchema)({
    monetaryAmount: { amount, currency },
    roundingRuleRevision: 'pricing-rounding:3',
    sourceRef: 'purchase-proposal:30000000-0000-4000-8000-000000000010',
    sourceRevision,
  });

const proposalEvidence = (
  evaluation: ReturnType<typeof evaluatePurchaseLimit>,
  state: 'CURRENT' | 'SUPERSEDED' | 'INDETERMINATE' = 'CURRENT',
) => ({
  evaluatedAt: decidedAt,
  evaluationContext,
  proposalRevisionRef: evaluation.purchaseValue.sourceRef,
  purchaseValue: evaluation.purchaseValue,
  revision: evaluation.purchaseValue.sourceRevision,
  state,
});

const policySnapshot = (
  policy: PurchaseLimitPolicy,
  subject: PurchaseLimitPolicySubject,
  revision = 1,
): PurchaseLimitPolicySnapshot =>
  Schema.decodeUnknownSync(PurchaseLimitPolicySnapshotSchema)({
    changedAt: decidedAtText,
    policy,
    policyRef: {
      moduleId: 'commerce.customer-context',
      resourceId: `40000000-0000-4000-8000-${String(revision).padStart(12, '0')}`,
      resourceType: 'commerce.customer-context.purchase-limit-policy',
      tenantId,
    },
    revision,
    subject,
  });

const monetaryPolicy = (amount: string, currency = 'CZK'): PurchaseLimitPolicy =>
  Schema.decodeUnknownSync(PurchaseLimitPolicySchema)({
    _tag: 'MONETARY_LIMIT',
    limit: { amount, currency },
  });

const monetaryDefault = (amount: string, currency = 'CZK') =>
  policySnapshot(monetaryPolicy(amount, currency), {
    _tag: 'COUNTERPARTY_DEFAULT',
    counterpartyRef,
  });

const unlimitedOverride = () =>
  policySnapshot(
    { _tag: 'UNLIMITED' },
    {
      _tag: 'PRINCIPAL_OVERRIDE',
      counterpartyRef,
      principalRef: { principalId, tenantId },
    },
    2,
  );

const evaluationInput = (
  value: PurchaseValue,
  counterpartyPolicies: readonly PurchaseLimitPolicySnapshot[] = [monetaryDefault('100')],
  principalOverrides: readonly PurchaseLimitPolicySnapshot[] = [],
): PurchaseLimitEvaluationInput => ({
  counterpartyPolicies,
  counterpartyRef,
  currentSourceRevisions: revisions,
  decidedAt,
  expectedSourceRevisions: revisions,
  principalId,
  principalOverrides,
  purchaseValue: value,
  sellingLegalEntityId,
  storefrontId,
});

const hasTag = <Tag extends string>(tag: Tag) =>
  Schema.is(Schema.Struct({ _tag: Schema.Literal(tag) }));

const requireEffectivePolicy = (
  result: EffectivePurchaseLimitPolicyResult,
): EffectivePurchaseLimitPolicy =>
  Match.value(result).pipe(
    Match.tag('EFFECTIVE_POLICY', ({ effectivePolicy }) => effectivePolicy),
    Match.orElse(() => {
      throw new Error('Expected an effective Purchase Limit policy');
    }),
  );

it('accepts only canonical non-negative exact decimal amounts within precision and scale', () => {
  for (const value of ['0', '0.01', '1', '1.23456789', '99999999999999999999999999999.123456789']) {
    expect(Schema.is(ExactNonNegativeDecimalSchema)(value)).toBe(true);
  }
  for (const value of [
    '-1',
    '+1',
    '01',
    '1.0',
    '1e3',
    '0.1234567890',
    '999999999999999999999999999999',
    '999999999999999999999999999999999999999',
  ]) {
    expect(Schema.is(ExactNonNegativeDecimalSchema)(value)).toBe(false);
  }
});

it('compares exact decimal boundaries without binary floating point', () => {
  const decode = Schema.decodeUnknownSync(ExactNonNegativeDecimalSchema);
  expect(compareExactDecimals(decode('0.1'), decode('0.01'))).toBe(1);
  expect(compareExactDecimals(decode('9007199254740993'), decode('9007199254740992'))).toBe(1);
  expect(compareExactDecimals(decode('10'), decode('10'))).toBe(0);
});

it('resolves the exact principal override as a full replacement of the counterparty default', () => {
  const result = resolveEffectivePurchaseLimitPolicy({
    counterpartyPolicies: [monetaryDefault('10')],
    counterpartyRef,
    principalId,
    principalOverrides: [unlimitedOverride()],
  });
  const effectivePolicy = requireEffectivePolicy(result);
  expect(effectivePolicy.source).toBe('PRINCIPAL_OVERRIDE');
  expect(hasTag('UNLIMITED')(effectivePolicy.policy)).toBe(true);
});

it('distinguishes missing, overlapping, and cross-counterparty policy from unlimited', () => {
  expect(
    hasTag('NO_EFFECTIVE_POLICY')(
      resolveEffectivePurchaseLimitPolicy({
        counterpartyPolicies: [],
        counterpartyRef,
        principalId,
        principalOverrides: [],
      }),
    ),
  ).toBe(true);
  const overlapping = resolveEffectivePurchaseLimitPolicy({
    counterpartyPolicies: [monetaryDefault('10'), monetaryDefault('20')],
    counterpartyRef,
    principalId,
    principalOverrides: [],
  });
  expect(hasTag('INCONSISTENT_POLICY')(overlapping)).toBe(true);
  expect(
    Match.value(overlapping).pipe(
      Match.tag('INCONSISTENT_POLICY', ({ reasonCode }) => reasonCode),
      Match.orElse(() => null),
    ),
  ).toBe('overlapping_current_policy');
  const crossCounterparty = resolveEffectivePurchaseLimitPolicy({
    counterpartyPolicies: [
      policySnapshot(monetaryPolicy('10'), {
        _tag: 'COUNTERPARTY_DEFAULT',
        counterpartyRef: otherCounterpartyRef,
      }),
    ],
    counterpartyRef,
    principalId,
    principalOverrides: [],
  });
  expect(hasTag('INCONSISTENT_POLICY')(crossCounterparty)).toBe(true);
  expect(
    Match.value(crossCounterparty).pipe(
      Match.tag('INCONSISTENT_POLICY', ({ reasonCode }) => reasonCode),
      Match.orElse(() => null),
    ),
  ).toBe('policy_subject_scope_mismatch');
});

it('evaluates zero, equality, above-boundary, and explicit unlimited semantics exactly', () => {
  expect(hasTag('WITHIN_LIMIT')(evaluatePurchaseLimit(evaluationInput(purchaseValue('100'))))).toBe(
    true,
  );
  expect(
    hasTag('APPROVAL_REQUIRED')(evaluatePurchaseLimit(evaluationInput(purchaseValue('100.01')))),
  ).toBe(true);
  expect(
    hasTag('WITHIN_LIMIT')(
      evaluatePurchaseLimit(evaluationInput(purchaseValue('0'), [monetaryDefault('0')])),
    ),
  ).toBe(true);
  expect(
    hasTag('APPROVAL_REQUIRED')(
      evaluatePurchaseLimit(evaluationInput(purchaseValue('0.01'), [monetaryDefault('0')])),
    ),
  ).toBe(true);
  const unlimited = evaluatePurchaseLimit(
    evaluationInput(purchaseValue('999999', 'EUR'), [monetaryDefault('0')], [unlimitedOverride()]),
  );
  expect(hasTag('WITHIN_LIMIT')(unlimited)).toBe(true);
  expect(
    Match.value(unlimited).pipe(
      Match.tag('WITHIN_LIMIT', ({ comparedValue }) => comparedValue),
      Match.orElse(() => null),
    ),
  ).toBeNull();
});

it('requires purpose-specific authoritative comparable value for cross-currency assessment', () => {
  const input = evaluationInput(purchaseValue('4', 'EUR'), [monetaryDefault('100', 'CZK')]);
  expect(hasTag('COMPARABLE_VALUE_REQUIRED')(evaluatePurchaseLimit(input))).toBe(true);
  const comparableValue = Schema.decodeUnknownSync(PurchaseLimitComparableValueSchema)({
    arithmeticVersion: 'comparable-value-arithmetic.v1',
    contextRevision: 'commerce-context:1',
    decidedAt: decidedAtText,
    decisionRef: 'comparable-value-decision:1',
    direction: 'SOURCE_TO_TARGET',
    maximumRateAgeSeconds: 300,
    monetaryAmount: purchaseValue('101').monetaryAmount,
    normalizedRate: '25',
    observedAt: '2026-09-09T09:59:00.000Z',
    policyRevision: 'comparable-value-policy:1',
    purpose: 'PURCHASE_LIMIT_COMPARISON' as const,
    quotedRate: '25',
    rateSourceId: 'reference-rate-source',
    retrievedAt: '2026-09-09T09:59:10.000Z',
    roundingIncrement: '0.01',
    roundingMode: 'half-even',
    roundingRule: 'QUANTIZE_TO_INCREMENT',
    roundingRuleRevision: 'comparable-value-rounding:2',
    source: 'comparable-value',
    sourcePurchaseValueRevision: input.purchaseValue.sourceRevision,
    sourceRevision: 'comparable-value:7',
    targetMinorUnits: 2,
    validFrom: '2026-09-09T09:00:00.000Z',
    validTo: '2026-09-09T11:00:00.000Z',
  });
  const outcome = evaluatePurchaseLimit({ ...input, comparableValue });
  expect(hasTag('APPROVAL_REQUIRED')(outcome)).toBe(true);
  expect(
    Match.value(outcome).pipe(
      Match.tag('APPROVAL_REQUIRED', ({ comparableValue: evidence }) => evidence),
      Match.orElse(() => null),
    ),
  ).toEqual(comparableValue);

  const firstEvaluation = evaluatePurchaseLimit({
    ...input,
    comparableValue,
    expectedSourceRevisions: input.expectedSourceRevisions.filter(
      ({ source }) => source !== 'comparable-value',
    ),
  });
  expect(hasTag('APPROVAL_REQUIRED')(firstEvaluation)).toBe(true);
});

it('reports every changed or missing source revision as stale before policy comparison', () => {
  expect(
    findStalePurchaseLimitSources(revisions, [
      ...revisions.filter(({ source }) => source !== 'purchase-proposal'),
      { revision: 'proposal:2', source: 'purchase-proposal' },
      { revision: 'override:1', source: 'principal-override' },
    ]),
  ).toEqual(['principal-override', 'purchase-proposal']);
  expect(
    findStalePurchaseLimitSources(revisions, [
      ...revisions.filter(({ source }) => source !== 'comparable-value'),
      { revision: 'comparable-value:8', source: 'comparable-value' },
    ]),
  ).toEqual(['comparable-value']);
  const outcome = evaluatePurchaseLimit({
    ...evaluationInput(purchaseValue('101')),
    currentSourceRevisions: [{ revision: 'proposal:2', source: 'purchase-proposal' }],
  });
  expect(hasTag('STALE_INPUT')(outcome)).toBe(true);
});

it.effect('never calls FX for same-currency or explicit unlimited policy', () =>
  Effect.gen(function* neverCallsFx() {
    let calls = 0;
    const fx: PurchaseLimitFxPort = {
      comparableValue: () =>
        Effect.sync(() => {
          calls += 1;
          throw new Error('FX must not be called');
        }),
    };
    const monetary = resolveEffectivePurchaseLimitPolicy({
      counterpartyPolicies: [monetaryDefault('100')],
      counterpartyRef,
      principalId,
      principalOverrides: [],
    });
    const unlimited = resolveEffectivePurchaseLimitPolicy({
      counterpartyPolicies: [monetaryDefault('100')],
      counterpartyRef,
      principalId,
      principalOverrides: [unlimitedOverride()],
    });
    expect(
      Option.isNone(
        yield* resolveComparablePurchaseValue({
          effectivePolicy: requireEffectivePolicy(monetary),
          purchaseValue: purchaseValue('50'),
        }).pipe(Effect.provideService(PurchaseLimitFx, fx)),
      ),
    ).toBe(true);
    expect(
      Option.isNone(
        yield* resolveComparablePurchaseValue({
          effectivePolicy: requireEffectivePolicy(unlimited),
          purchaseValue: purchaseValue('50', 'EUR'),
        }).pipe(Effect.provideService(PurchaseLimitFx, fx)),
      ),
    ).toBe(true);
    expect(calls).toBe(0);
  }),
);

it.effect('submits only a genuine approval-required result and preserves dependency failure', () =>
  Effect.gen(function* submitsOnlyGenuineApproval() {
    let calls = 0;
    const approvalRequired = evaluatePurchaseLimit(evaluationInput(purchaseValue('101')));
    const withinLimit = evaluatePurchaseLimit(evaluationInput(purchaseValue('100')));
    const port = {
      submit: () =>
        Effect.sync(() => {
          calls += 1;
          return { _tag: 'APPROVAL_SUBMITTED' as const, approvalRequestRef: 'approval:1' };
        }),
    };
    const direct = yield* triggerPurchaseApproval({
      buyerPermission: 'ALLOWED',
      evaluation: withinLimit,
      idempotencyKey: 'trigger:1',
      profileEvidence,
      proposalEvidence: proposalEvidence(withinLimit),
      trustedContext: evaluationContext,
    }).pipe(Effect.provideService(PurchaseApprovalSubmission, port));
    expect(hasTag('DIRECT_PURCHASE_ALLOWED')(direct)).toBe(true);
    const denied = yield* triggerPurchaseApproval({
      buyerPermission: 'DENIED',
      evaluation: approvalRequired,
      idempotencyKey: 'trigger:denied',
      profileEvidence,
      proposalEvidence: proposalEvidence(approvalRequired),
      trustedContext: evaluationContext,
    }).pipe(Effect.provideService(PurchaseApprovalSubmission, port));
    expect(hasTag('APPROVAL_PRECONDITION_FAILED')(denied)).toBe(true);
    expect(
      Match.value(denied).pipe(
        Match.tag('APPROVAL_PRECONDITION_FAILED', ({ reasonCode }) => reasonCode),
        Match.orElse(() => null),
      ),
    ).toBe('buyer_permission_denied');
    const submitted = yield* triggerPurchaseApproval({
      buyerPermission: 'ALLOWED',
      evaluation: approvalRequired,
      idempotencyKey: 'trigger:2',
      profileEvidence,
      proposalEvidence: proposalEvidence(approvalRequired),
      trustedContext: evaluationContext,
    }).pipe(Effect.provideService(PurchaseApprovalSubmission, port));
    expect(hasTag('APPROVAL_SUBMITTED')(submitted)).toBe(true);
    expect(
      Match.value(submitted).pipe(
        Match.tag('APPROVAL_SUBMITTED', ({ approvalRequestRef }) => approvalRequestRef),
        Match.orElse(() => null),
      ),
    ).toBe('approval:1');
    expect(calls).toBe(1);

    const unavailable = yield* triggerPurchaseApproval({
      buyerPermission: 'ALLOWED',
      evaluation: approvalRequired,
      idempotencyKey: 'trigger:3',
      profileEvidence,
      proposalEvidence: proposalEvidence(approvalRequired),
      trustedContext: evaluationContext,
    }).pipe(
      Effect.provideService(PurchaseApprovalSubmission, {
        submit: () =>
          Effect.fail({
            _tag: 'PurchaseApprovalDependencyUnavailable' as const,
            code: 'purchase_approval_dependency_unavailable' as const,
            dependency: 'PURCHASING_APPROVAL' as const,
            reason: 'Approval owner unavailable',
            retryable: true as const,
          }),
      }),
      Effect.flip,
    );
    expect(Schema.is(PurchaseApprovalDependencyUnavailableSchema)(unavailable)).toBe(true);

    const buyerUnavailable = yield* triggerPurchaseApproval({
      buyerPermission: 'UNAVAILABLE',
      evaluation: approvalRequired,
      idempotencyKey: 'trigger:buyer-unavailable',
      profileEvidence,
      proposalEvidence: proposalEvidence(approvalRequired),
      trustedContext: evaluationContext,
    }).pipe(Effect.provideService(PurchaseApprovalSubmission, port), Effect.flip);
    expect(
      Schema.decodeUnknownSync(PurchaseApprovalDependencyUnavailableSchema)(buyerUnavailable)
        .dependency,
    ).toBe('BUYER_AUTHORIZATION');

    const profileUnavailable = yield* triggerPurchaseApproval({
      buyerPermission: 'ALLOWED',
      evaluation: approvalRequired,
      idempotencyKey: 'trigger:profile-unavailable',
      profileEvidence: {
        ...profileEvidence,
        gate: { canAcceptNewOrder: false, outcome: 'DEPENDENCY_UNAVAILABLE' },
      },
      proposalEvidence: proposalEvidence(approvalRequired),
      trustedContext: evaluationContext,
    }).pipe(Effect.provideService(PurchaseApprovalSubmission, port), Effect.flip);
    expect(
      Schema.decodeUnknownSync(PurchaseApprovalDependencyUnavailableSchema)(profileUnavailable)
        .dependency,
    ).toBe('CUSTOMER_PROFILE');

    const proposalIndeterminate = yield* triggerPurchaseApproval({
      buyerPermission: 'ALLOWED',
      evaluation: approvalRequired,
      idempotencyKey: 'trigger:proposal-indeterminate',
      profileEvidence,
      proposalEvidence: proposalEvidence(approvalRequired, 'INDETERMINATE'),
      trustedContext: evaluationContext,
    }).pipe(Effect.provideService(PurchaseApprovalSubmission, port), Effect.flip);
    expect(Schema.is(PurchaseApprovalCurrentnessIndeterminateSchema)(proposalIndeterminate)).toBe(
      true,
    );

    const mixedProfile = yield* triggerPurchaseApproval({
      buyerPermission: 'ALLOWED',
      evaluation: approvalRequired,
      idempotencyKey: 'trigger:mixed-profile',
      profileEvidence: { ...profileEvidence, counterpartyRef: otherCounterpartyRef },
      proposalEvidence: proposalEvidence(approvalRequired),
      trustedContext: evaluationContext,
    }).pipe(Effect.provideService(PurchaseApprovalSubmission, port));
    expect(
      Match.value(mixedProfile).pipe(
        Match.tag('APPROVAL_PRECONDITION_FAILED', ({ reasonCode }) => reasonCode),
        Match.orElse(() => null),
      ),
    ).toBe('profile_counterparty_mismatch');

    const mixedProposal = yield* triggerPurchaseApproval({
      buyerPermission: 'ALLOWED',
      evaluation: approvalRequired,
      idempotencyKey: 'trigger:mixed-proposal',
      profileEvidence,
      proposalEvidence: {
        ...proposalEvidence(approvalRequired),
        purchaseValue: purchaseValue('102'),
      },
      trustedContext: evaluationContext,
    }).pipe(Effect.provideService(PurchaseApprovalSubmission, port));
    expect(
      Match.value(mixedProposal).pipe(
        Match.tag('APPROVAL_PRECONDITION_FAILED', ({ reasonCode }) => reasonCode),
        Match.orElse(() => null),
      ),
    ).toBe('proposal_value_mismatch');

    const untrustedStorefront = yield* triggerPurchaseApproval({
      buyerPermission: 'ALLOWED',
      evaluation: approvalRequired,
      idempotencyKey: 'trigger:untrusted-storefront',
      profileEvidence,
      proposalEvidence: proposalEvidence(approvalRequired),
      trustedContext: {
        ...evaluationContext,
        storefrontId: Schema.decodeUnknownSync(
          PurchaseLimitEvaluationContextSchema.fields.storefrontId,
        )('storefront:other'),
      },
    }).pipe(Effect.provideService(PurchaseApprovalSubmission, port));
    expect(
      Match.value(untrustedStorefront).pipe(
        Match.tag('APPROVAL_PRECONDITION_FAILED', ({ reasonCode }) => reasonCode),
        Match.orElse(() => null),
      ),
    ).toBe('evaluation_context_mismatch');
    expect(calls).toBe(1);
  }),
);
