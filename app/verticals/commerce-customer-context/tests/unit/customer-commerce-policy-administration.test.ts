import { describe, expect, it } from 'effect-rstest';
import { Schema } from 'effect';
import {
  AssignCommerceQuantityCommandTagSchema,
  BrokenAssignmentTagSchema,
  CommerceQuantityAssignmentPayloadSchema,
  CreateRevisionCommandTagSchema,
  CurrentCommerceQuantityAssignmentSchema,
  CurrentCommerceQuantityPolicySetSchema,
  CurrentCommerceQuantityRuleCandidateSchema,
  CurrentPaymentTermPolicyCandidateSchema,
  CurrentPurchaseCurrencyPolicyCandidateSchema,
  CurrentPurchaseCurrencyPolicySetSchema,
  CustomerCommercePolicyChangedTagSchema,
  CustomerCommercePolicyTrustedActionContextSchema,
  CustomerCommercePolicyUnchangedTagSchema,
  GenerationConflictTagSchema,
  IdempotencyConflictTagSchema,
  InvalidLifecycleTransitionTagSchema,
  MarketBootstrapPolicyBatchCurrentExchangeSchema,
  MarketBootstrapPolicyBatchCurrentRequestSchema,
  MarketBootstrapPolicyBatchCurrentResponseSchema,
  OverlappingCurrentRevisionTagSchema,
  PurchaseCurrencyPolicyAdministrationCommandSchema,
  PurchaseCurrencyPolicyAdministrationPayloadSchema,
  ReplaceRevisionCommandTagSchema,
  ScopeMismatchTagSchema,
  administerPurchaseCurrencyPolicy,
  assignCommerceQuantityRule,
  currentCommerceQuantityAssignmentSet,
  currentCommerceQuantityPolicySet,
  currentPurchaseCurrencyPolicySet,
  emptyCustomerCommercePolicySet,
  emptyQuantityAssignmentSet,
  toTrustedCommerceQuantityAssignmentCommand,
  toTrustedPurchaseCurrencyPolicyAdministrationCommand,
} from '../../shared/domain/customer-commerce-policy-administration.ts';
import { CommerceQuantityRuleRevisionSchema } from '../../shared/domain/customer-commerce-policy.ts';

const tenantId = '55555555-5555-4555-8555-555555555555';
const sellingLegalEntityId = '44444444-4444-4444-8444-444444444444';
const observedAt = '2026-09-21T10:00:00.000Z';

const trusted = Schema.decodeUnknownSync(CustomerCommercePolicyTrustedActionContextSchema)({
  actionInvocationId: '11111111-1111-4111-8111-111111111111',
  actorPrincipalId: '22222222-2222-4222-8222-222222222222',
  sellingLegalEntityId,
  tenantId,
});

const revisionPayload = {
  effectiveFrom: '2026-10-01T00:00:00.000Z',
  effectiveTo: null,
  field: 'PURCHASE_CURRENCY',
  idempotencyKey: 'currency-czk-v1',
  lifecycle: 'ACTIVE',
  reason: 'Approved Launch currency constraint',
  revisionId: '33333333-3333-4333-8333-333333333333',
  scope: {
    channelId: 'b2b',
    kind: 'CHANNEL_SELLER',
    sellingLegalEntityId,
  },
  value: { currencyCode: 'CZK', kind: 'ALLOWED_CURRENCY_CONSTRAINT' },
} as const;

const createCurrencyCommand = (
  overrides: {
    readonly effectiveTo?: string | null;
    readonly idempotencyKey?: string;
    readonly lifecycle?: 'ACTIVE' | 'RETIRED' | 'SCHEDULED';
    readonly revisionId?: string;
    readonly value?: { readonly currencyCode: string; readonly kind: 'ALLOWED_CURRENCY_CONSTRAINT' };
  } = {},
  expectedGeneration = 0,
) => {
  const payload = Schema.decodeUnknownSync(PurchaseCurrencyPolicyAdministrationPayloadSchema)({
    _tag: 'CREATE_REVISION',
    expectedGeneration,
    revision: { ...revisionPayload, ...overrides },
  });
  return toTrustedPurchaseCurrencyPolicyAdministrationCommand(payload, trusted, observedAt);
};

const catalogRef = (resourceType: string, resourceId: string) => ({
  moduleId: 'commerce.catalog',
  resourceId,
  resourceType,
  tenantId,
});

const quantityRule = Schema.decodeUnknownSync(CommerceQuantityRuleRevisionSchema)({
  actionInvocationId: trusted.actionInvocationId,
  actorPrincipalId: trusted.actorPrincipalId,
  effectiveFrom: '2026-10-01T00:00:00.000Z',
  effectiveTo: null,
  field: 'COMMERCE_QUANTITY_RULE',
  idempotencyKey: 'quantity-rule-1',
  lifecycle: 'ACTIVE',
  reason: 'Approved shared Product envelope',
  revisionId: '77777777-7777-4777-8777-777777777777',
  scope: {
    channelId: 'b2b',
    commerceMarketId: 'cz-market',
    kind: 'MARKET_CHANNEL_SELLER',
    sellingLegalEntityId,
  },
  tenantId,
  value: {
    basis: {
      targetDivisibilityRevision: 3,
      targetRef: catalogRef('commerce.catalog.variant', '55555555-5555-4555-8555-555555555555'),
      unitRef: catalogRef('commerce.catalog.product-unit', '66666666-6666-4666-8666-666666666666'),
      unitRuleRevision: 4,
    },
    constraintMode: 'REPLACEABLE_ENVELOPE',
    envelope: { kind: 'BOUNDED', maximum: null, minimum: '1', multiple: '1' },
    kind: 'COMMERCE_QUANTITY_RULE',
    selector: { kind: 'PRODUCT', productRef: catalogRef('commerce.catalog.product', 'product-1') },
  },
});

const quantityRuleState = {
  commandReceipts: [],
  field: 'COMMERCE_QUANTITY_RULE' as const,
  generation: 1,
  lifecycleTransitions: [],
  revisions: [quantityRule],
};

const assignmentPayload = (
  overrides: {
    readonly assignmentId?: string;
    readonly effectiveFrom?: string;
    readonly idempotencyKey?: string;
    readonly reason?: string;
  } = {},
  expectedGeneration = 0,
) =>
  Schema.decodeUnknownSync(CommerceQuantityAssignmentPayloadSchema)({
    _tag: 'ASSIGN',
    assignment: {
      assignmentId: '66666666-6666-4666-8666-666666666666',
      effectiveFrom: '2026-10-01T00:00:00.000Z',
      effectiveTo: null,
      idempotencyKey: 'assign-product-rule',
      lifecycle: 'ACTIVE',
      profile: {
        kind: 'COUNTERPARTY',
        profileRef: {
          moduleId: 'commerce.customer-context',
          resourceId: '88888888-8888-4888-8888-888888888888',
          resourceType: 'commerce.customer-context.counterparty-purchasing-profile',
          tenantId,
        },
      },
      reason: 'Approved customer-specific Quantity envelope',
      ruleRevisionRef: {
        moduleId: 'commerce.customer-context',
        resourceId: quantityRule.revisionId,
        resourceType: 'commerce.customer-context.commerce-quantity-rule',
        tenantId,
      },
      ...overrides,
    },
    expectedGeneration,
  });

describe('Customer Commerce Policy administration', () => {
  it('requires exactly one seller-qualified bootstrap partition for every requested eligible seller', () => {
    const secondSellerId = '99999999-9999-4999-8999-999999999999';
    const firstBootstrapRevisionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
    const secondBootstrapRevisionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2';
    const request = Schema.decodeUnknownSync(MarketBootstrapPolicyBatchCurrentRequestSchema)({
      at: '2026-10-01T00:00:00.000Z',
      eligibleSellingLegalEntityIds: [sellingLegalEntityId, secondSellerId],
    });
    const partition = (sellerId: string, revisionId: string) => ({
      candidates: [
        {
          defaultTuple: {
            channelId: 'b2b',
            commerceMarketId: 'cz-market',
            sellingLegalEntityId: sellerId,
          },
          policyRevisionId: revisionId,
          scope: { kind: 'SELLER', sellingLegalEntityId: sellerId },
        },
      ],
      completeness: {
        observedAt: request.at,
        ownerRevision: `MARKET_BOOTSTRAP:${revisionId}`,
        scope: {
          kind: 'EXACT_PREDICATE',
          predicateRef: `commerce.customer-context.policy.market_bootstrap.current.seller.${sellerId}`,
        },
      },
      sellingLegalEntityId: sellerId,
    });
    const response = Schema.decodeUnknownSync(MarketBootstrapPolicyBatchCurrentResponseSchema)({
      sellers: [
        partition(sellingLegalEntityId, firstBootstrapRevisionId),
        partition(secondSellerId, secondBootstrapRevisionId),
      ],
    });
    expect(
      Schema.decodeUnknownSync(MarketBootstrapPolicyBatchCurrentExchangeSchema)({ request, response }).response.sellers,
    ).toHaveLength(2);

    expect(() =>
      Schema.decodeUnknownSync(MarketBootstrapPolicyBatchCurrentExchangeSchema)({
        request,
        response: { sellers: [partition(sellingLegalEntityId, firstBootstrapRevisionId)] },
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(MarketBootstrapPolicyBatchCurrentResponseSchema)({
        sellers: [
          {
            ...partition(sellingLegalEntityId, firstBootstrapRevisionId),
            candidates: partition(secondSellerId, secondBootstrapRevisionId).candidates,
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(MarketBootstrapPolicyBatchCurrentRequestSchema)({
        at: request.at,
        eligibleSellingLegalEntityIds: Array.from(
          { length: 257 },
          (_, index) => `90000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`,
        ),
      }),
    ).toThrow();
  });

  it('decodes one _tag command shape that passes directly to the pure domain function', () => {
    const command = createCurrencyCommand();
    const decoded = Schema.decodeUnknownSync(PurchaseCurrencyPolicyAdministrationCommandSchema)(command);
    expect(Schema.is(CreateRevisionCommandTagSchema)(decoded)).toBe(true);

    const created = administerPurchaseCurrencyPolicy(emptyCustomerCommercePolicySet('PURCHASE_CURRENCY'), decoded);
    expect(Schema.is(CustomerCommercePolicyChangedTagSchema)(created)).toBe(true);
    if (!Schema.is(CustomerCommercePolicyChangedTagSchema)(created)) {
      throw new Error('expected creation');
    }
    expect(created.state.generation).toBe(1);
  });

  it('keeps caller payloads free of trusted identity and time', () => {
    expect(() =>
      Schema.decodeUnknownSync(PurchaseCurrencyPolicyAdministrationPayloadSchema)({
        _tag: 'CREATE_REVISION',
        expectedGeneration: 0,
        observedAt,
        revision: revisionPayload,
        tenantId,
      }),
    ).toThrow();
    for (const uuidField of ['actionInvocationId', 'actorPrincipalId', 'sellingLegalEntityId'] as const) {
      expect(() =>
        Schema.decodeUnknownSync(CustomerCommercePolicyTrustedActionContextSchema)({
          ...trusted,
          [uuidField]: 'not-a-uuid',
        }),
      ).toThrow();
    }
  });

  it('makes exact idempotent retries generation-independent and rejects same-key changed payloads', () => {
    const command = createCurrencyCommand();
    const created = administerPurchaseCurrencyPolicy(emptyCustomerCommercePolicySet('PURCHASE_CURRENCY'), command);
    if (!Schema.is(CustomerCommercePolicyChangedTagSchema)(created)) {
      throw new Error('expected creation');
    }

    const replay = administerPurchaseCurrencyPolicy(created.state, command);
    expect(Schema.is(CustomerCommercePolicyUnchangedTagSchema)(replay)).toBe(true);
    if (!Schema.is(CustomerCommercePolicyUnchangedTagSchema)(replay)) {
      throw new Error('expected unchanged replay');
    }
    expect(replay.state.generation).toBe(1);
    const conflictingReplay = administerPurchaseCurrencyPolicy(
      created.state,
      createCurrencyCommand({ value: { currencyCode: 'EUR', kind: 'ALLOWED_CURRENCY_CONSTRAINT' } }),
    );
    expect(Schema.is(IdempotencyConflictTagSchema)(conflictingReplay)).toBe(true);
  });

  it('rejects retired creation, revision identity reuse, and replacement of non-current predecessors', () => {
    const retiredCreate = administerPurchaseCurrencyPolicy(
      emptyCustomerCommercePolicySet('PURCHASE_CURRENCY'),
      createCurrencyCommand({ lifecycle: 'RETIRED' }),
    );
    expect(Schema.is(InvalidLifecycleTransitionTagSchema)(retiredCreate)).toBe(true);

    const created = administerPurchaseCurrencyPolicy(
      emptyCustomerCommercePolicySet('PURCHASE_CURRENCY'),
      createCurrencyCommand(),
    );
    if (!Schema.is(CustomerCommercePolicyChangedTagSchema)(created)) {
      throw new Error('expected creation');
    }
    const reusedIdentity = administerPurchaseCurrencyPolicy(
      created.state,
      createCurrencyCommand({ idempotencyKey: 'reuse-revision-id' }, 1),
    );
    expect(Schema.is(InvalidLifecycleTransitionTagSchema)(reusedIdentity)).toBe(true);

    const scheduled = administerPurchaseCurrencyPolicy(
      emptyCustomerCommercePolicySet('PURCHASE_CURRENCY'),
      createCurrencyCommand({ lifecycle: 'SCHEDULED' }),
    );
    if (!Schema.is(CustomerCommercePolicyChangedTagSchema)(scheduled)) {
      throw new Error('expected scheduled creation');
    }
    const replaceScheduledPayload = Schema.decodeUnknownSync(PurchaseCurrencyPolicyAdministrationPayloadSchema)({
      _tag: 'REPLACE_REVISION',
      expectedGeneration: 1,
      replacedRevisionId: revisionPayload.revisionId,
      replacement: {
        ...revisionPayload,
        effectiveFrom: '2027-01-01T00:00:00.000Z',
        idempotencyKey: 'replace-scheduled-predecessor',
        lifecycle: 'SCHEDULED',
        revisionId: '33333333-3333-4333-8333-333333333337',
      },
    });
    if (!Schema.is(ReplaceRevisionCommandTagSchema)(replaceScheduledPayload)) {
      throw new Error('expected replacement payload');
    }
    const replaceScheduled = administerPurchaseCurrencyPolicy(
      scheduled.state,
      toTrustedPurchaseCurrencyPolicyAdministrationCommand(replaceScheduledPayload, trusted, observedAt),
    );
    expect(Schema.is(InvalidLifecycleTransitionTagSchema)(replaceScheduled)).toBe(true);

    const retiredReplacementPayload = Schema.decodeUnknownSync(PurchaseCurrencyPolicyAdministrationPayloadSchema)({
      ...replaceScheduledPayload,
      replacement: { ...replaceScheduledPayload.replacement, lifecycle: 'RETIRED' },
    });
    const retiredReplacement = administerPurchaseCurrencyPolicy(
      created.state,
      toTrustedPurchaseCurrencyPolicyAdministrationCommand(retiredReplacementPayload, trusted, observedAt),
    );
    expect(Schema.is(InvalidLifecycleTransitionTagSchema)(retiredReplacement)).toBe(true);

    const retirePayload = Schema.decodeUnknownSync(PurchaseCurrencyPolicyAdministrationPayloadSchema)({
      _tag: 'RETIRE_REVISION',
      effectiveAt: '2027-02-01T00:00:00.000Z',
      expectedGeneration: 1,
      idempotencyKey: 'future-retirement',
      reason: 'Future retirement already governed',
      revisionId: revisionPayload.revisionId,
    });
    const futureRetired = administerPurchaseCurrencyPolicy(
      created.state,
      toTrustedPurchaseCurrencyPolicyAdministrationCommand(retirePayload, trusted, observedAt),
    );
    if (!Schema.is(CustomerCommercePolicyChangedTagSchema)(futureRetired)) {
      throw new Error('expected future retirement');
    }
    const backdatedReplacementPayload = Schema.decodeUnknownSync(PurchaseCurrencyPolicyAdministrationPayloadSchema)({
      ...replaceScheduledPayload,
      expectedGeneration: 2,
      replacement: {
        ...replaceScheduledPayload.replacement,
        effectiveFrom: '2027-01-01T00:00:00.000Z',
        idempotencyKey: 'backdated-replacement',
        revisionId: '33333333-3333-4333-8333-333333333338',
      },
    });
    const backdatedReplacement = administerPurchaseCurrencyPolicy(
      futureRetired.state,
      toTrustedPurchaseCurrencyPolicyAdministrationCommand(backdatedReplacementPayload, trusted, observedAt),
    );
    expect(Schema.is(InvalidLifecycleTransitionTagSchema)(backdatedReplacement)).toBe(true);
  });

  it('rejects stale generations, overlapping exact candidates, and trusted-scope mismatch', () => {
    const first = administerPurchaseCurrencyPolicy(
      emptyCustomerCommercePolicySet('PURCHASE_CURRENCY'),
      createCurrencyCommand(),
    );
    if (!Schema.is(CustomerCommercePolicyChangedTagSchema)(first)) {
      throw new Error('expected creation');
    }

    const stalePayload = Schema.decodeUnknownSync(PurchaseCurrencyPolicyAdministrationPayloadSchema)({
      _tag: 'CREATE_REVISION',
      expectedGeneration: 0,
      revision: {
        ...revisionPayload,
        idempotencyKey: 'currency-czk-v2',
        revisionId: '33333333-3333-4333-8333-333333333334',
      },
    });
    const stale = toTrustedPurchaseCurrencyPolicyAdministrationCommand(stalePayload, trusted, observedAt);
    const staleResult = administerPurchaseCurrencyPolicy(first.state, stale);
    expect(Schema.is(GenerationConflictTagSchema)(staleResult)).toBe(true);
    if (!Schema.is(GenerationConflictTagSchema)(staleResult)) {
      throw new Error('expected generation conflict');
    }
    expect(staleResult.actualGeneration).toBe(1);

    const overlapPayload = Schema.decodeUnknownSync(PurchaseCurrencyPolicyAdministrationPayloadSchema)({
      ...stalePayload,
      expectedGeneration: 1,
    });
    const overlap = toTrustedPurchaseCurrencyPolicyAdministrationCommand(overlapPayload, trusted, observedAt);
    expect(Schema.is(OverlappingCurrentRevisionTagSchema)(administerPurchaseCurrencyPolicy(first.state, overlap))).toBe(
      true,
    );

    const wrongScopePayload = Schema.decodeUnknownSync(PurchaseCurrencyPolicyAdministrationPayloadSchema)({
      _tag: 'CREATE_REVISION',
      expectedGeneration: 1,
      revision: {
        ...revisionPayload,
        idempotencyKey: 'wrong-scope',
        revisionId: '33333333-3333-4333-8333-333333333335',
        scope: {
          ...revisionPayload.scope,
          sellingLegalEntityId: '44444444-4444-4444-8444-444444444445',
        },
      },
    });
    expect(
      Schema.is(ScopeMismatchTagSchema)(
        administerPurchaseCurrencyPolicy(
          first.state,
          toTrustedPurchaseCurrencyPolicyAdministrationCommand(wrongScopePayload, trusted, observedAt),
        ),
      ),
    ).toBe(true);
  });

  it('replaces prospectively without rewriting the predecessor and projects half-open Current state', () => {
    const first = administerPurchaseCurrencyPolicy(
      emptyCustomerCommercePolicySet('PURCHASE_CURRENCY'),
      createCurrencyCommand(),
    );
    if (!Schema.is(CustomerCommercePolicyChangedTagSchema)(first)) {
      throw new Error('expected creation');
    }
    const [original] = first.state.revisions;
    if (original === undefined) {
      throw new Error('expected original revision');
    }
    const replacementPayload = Schema.decodeUnknownSync(PurchaseCurrencyPolicyAdministrationPayloadSchema)({
      _tag: 'REPLACE_REVISION',
      expectedGeneration: 1,
      replacedRevisionId: revisionPayload.revisionId,
      replacement: {
        ...revisionPayload,
        effectiveFrom: '2027-01-01T00:00:00.000Z',
        idempotencyKey: 'currency-eur-v1',
        lifecycle: 'SCHEDULED',
        revisionId: '33333333-3333-4333-8333-333333333336',
        value: { currencyCode: 'EUR', kind: 'ALLOWED_CURRENCY_CONSTRAINT' },
      },
    });
    const replacement = toTrustedPurchaseCurrencyPolicyAdministrationCommand(replacementPayload, trusted, observedAt);
    const replaced = administerPurchaseCurrencyPolicy(first.state, replacement);
    expect(Schema.is(CustomerCommercePolicyChangedTagSchema)(replaced)).toBe(true);
    if (!Schema.is(CustomerCommercePolicyChangedTagSchema)(replaced)) {
      throw new Error('expected replacement');
    }

    expect(replaced.state.revisions[0]).toBe(original);
    expect(replaced.state.revisions[0]).toEqual(original);
    expect(replaced.state.lifecycleTransitions).toHaveLength(2);
    expect(
      currentPurchaseCurrencyPolicySet(replaced.state, '2026-12-31T23:59:59.999Z').candidates.map(
        ({ policyRevisionId }) => policyRevisionId,
      ),
    ).toEqual([original.revisionId]);
    expect(
      currentPurchaseCurrencyPolicySet(replaced.state, '2027-01-01T00:00:00.000Z').candidates.map(
        ({ policyRevisionId }) => policyRevisionId,
      ),
    ).toEqual(['33333333-3333-4333-8333-333333333336']);
  });

  it('excludes scheduled and retired revisions until a valid lifecycle transition makes them Active', () => {
    const scheduled = createCurrencyCommand({ lifecycle: 'SCHEDULED' });
    const created = administerPurchaseCurrencyPolicy(emptyCustomerCommercePolicySet('PURCHASE_CURRENCY'), scheduled);
    if (!Schema.is(CustomerCommercePolicyChangedTagSchema)(created)) {
      throw new Error('expected creation');
    }
    expect(currentPurchaseCurrencyPolicySet(created.state, '2026-10-02T00:00:00.000Z').candidates).toEqual([]);

    const activatePayload = Schema.decodeUnknownSync(PurchaseCurrencyPolicyAdministrationPayloadSchema)({
      _tag: 'ACTIVATE_REVISION',
      effectiveAt: '2026-10-01T00:00:00.000Z',
      expectedGeneration: 1,
      idempotencyKey: 'activate-czk',
      reason: 'Effective date reached',
      revisionId: revisionPayload.revisionId,
    });
    const activated = administerPurchaseCurrencyPolicy(
      created.state,
      toTrustedPurchaseCurrencyPolicyAdministrationCommand(activatePayload, trusted, observedAt),
    );
    if (!Schema.is(CustomerCommercePolicyChangedTagSchema)(activated)) {
      throw new Error('expected activation');
    }
    expect(currentPurchaseCurrencyPolicySet(activated.state, '2026-10-02T00:00:00.000Z').candidates).toHaveLength(1);

    const retirePayload = Schema.decodeUnknownSync(PurchaseCurrencyPolicyAdministrationPayloadSchema)({
      _tag: 'RETIRE_REVISION',
      effectiveAt: '2026-11-01T00:00:00.000Z',
      expectedGeneration: 2,
      idempotencyKey: 'retire-czk',
      reason: 'Superseded policy',
      revisionId: revisionPayload.revisionId,
    });
    const retired = administerPurchaseCurrencyPolicy(
      activated.state,
      toTrustedPurchaseCurrencyPolicyAdministrationCommand(retirePayload, trusted, observedAt),
    );
    if (!Schema.is(CustomerCommercePolicyChangedTagSchema)(retired)) {
      throw new Error('expected retirement');
    }
    expect(currentPurchaseCurrencyPolicySet(retired.state, '2026-11-01T00:00:00.000Z').candidates).toEqual([]);
  });

  it('rejects missing and out-of-period quantity assignments and preserves exact attribution', () => {
    expect(() => assignmentPayload({ assignmentId: 'not-a-uuid' })).toThrow();
    const payload = assignmentPayload();
    const command = toTrustedCommerceQuantityAssignmentCommand(payload, trusted, observedAt);
    expect(Schema.is(AssignCommerceQuantityCommandTagSchema)(command)).toBe(true);
    if (!Schema.is(AssignCommerceQuantityCommandTagSchema)(command)) {
      throw new Error('expected assignment command');
    }
    expect(command.assignment).toMatchObject({
      actionInvocationId: trusted.actionInvocationId,
      actorPrincipalId: trusted.actorPrincipalId,
      recordedAt: observedAt,
      sellingLegalEntityId,
    });

    const broken = assignCommerceQuantityRule(
      emptyQuantityAssignmentSet(),
      emptyCustomerCommercePolicySet('COMMERCE_QUANTITY_RULE'),
      command,
    );
    expect(Schema.is(BrokenAssignmentTagSchema)(broken)).toBe(true);
    if (!Schema.is(BrokenAssignmentTagSchema)(broken)) {
      throw new Error('expected broken assignment');
    }
    expect(broken.ruleRevisionId).toBe(quantityRule.revisionId);

    const scheduledRuleState = {
      ...quantityRuleState,
      revisions: [{ ...quantityRule, lifecycle: 'SCHEDULED' as const }],
    };
    expect(
      Schema.is(InvalidLifecycleTransitionTagSchema)(
        assignCommerceQuantityRule(emptyQuantityAssignmentSet(), scheduledRuleState, command),
      ),
    ).toBe(true);

    const tooEarly = toTrustedCommerceQuantityAssignmentCommand(
      assignmentPayload({ effectiveFrom: '2026-09-30T00:00:00.000Z' }),
      trusted,
      observedAt,
    );
    expect(
      Schema.is(InvalidLifecycleTransitionTagSchema)(
        assignCommerceQuantityRule(emptyQuantityAssignmentSet(), quantityRuleState, tooEarly),
      ),
    ).toBe(true);
  });

  it('enforces assignment idempotency and validates unassignment before changing Current state', () => {
    const command = toTrustedCommerceQuantityAssignmentCommand(assignmentPayload(), trusted, observedAt);
    const assigned = assignCommerceQuantityRule(emptyQuantityAssignmentSet(), quantityRuleState, command);
    if (!Schema.is(CustomerCommercePolicyChangedTagSchema)(assigned)) {
      throw new Error('expected assignment');
    }

    expect(
      Schema.is(CustomerCommercePolicyUnchangedTagSchema)(
        assignCommerceQuantityRule(assigned.state, quantityRuleState, command),
      ),
    ).toBe(true);
    const changedSameKey = toTrustedCommerceQuantityAssignmentCommand(
      assignmentPayload({ reason: 'Different business payload' }),
      trusted,
      observedAt,
    );
    expect(
      Schema.is(IdempotencyConflictTagSchema)(
        assignCommerceQuantityRule(assigned.state, quantityRuleState, changedSameKey),
      ),
    ).toBe(true);

    const invalidUnassignPayload = Schema.decodeUnknownSync(CommerceQuantityAssignmentPayloadSchema)({
      _tag: 'UNASSIGN',
      assignmentId: '66666666-6666-4666-8666-666666666666',
      effectiveAt: '2026-10-01T00:00:00.000Z',
      expectedGeneration: 1,
      idempotencyKey: 'unassign-product-rule',
      reason: 'Assignment no longer applies',
    });
    const invalidUnassign = toTrustedCommerceQuantityAssignmentCommand(invalidUnassignPayload, trusted, observedAt);
    expect(
      Schema.is(InvalidLifecycleTransitionTagSchema)(
        assignCommerceQuantityRule(assigned.state, quantityRuleState, invalidUnassign),
      ),
    ).toBe(true);

    const unassignPayload = Schema.decodeUnknownSync(CommerceQuantityAssignmentPayloadSchema)({
      ...invalidUnassignPayload,
      effectiveAt: '2026-11-01T00:00:00.000Z',
    });
    const unassign = toTrustedCommerceQuantityAssignmentCommand(unassignPayload, trusted, observedAt);
    const unassigned = assignCommerceQuantityRule(assigned.state, quantityRuleState, unassign);
    if (!Schema.is(CustomerCommercePolicyChangedTagSchema)(unassigned)) {
      throw new Error('expected unassignment');
    }
    expect(currentCommerceQuantityAssignmentSet(unassigned.state, '2026-10-31T23:59:59.999Z').assignments).toHaveLength(
      1,
    );
    expect(currentCommerceQuantityAssignmentSet(unassigned.state, '2026-11-01T00:00:00.000Z').assignments).toEqual([]);
    expect(
      Schema.is(CustomerCommercePolicyUnchangedTagSchema)(
        assignCommerceQuantityRule(unassigned.state, quantityRuleState, unassign),
      ),
    ).toBe(true);

    const conflictingUnassignPayload = Schema.decodeUnknownSync(CommerceQuantityAssignmentPayloadSchema)({
      ...unassignPayload,
      effectiveAt: '2026-12-01T00:00:00.000Z',
    });
    expect(
      Schema.is(IdempotencyConflictTagSchema)(
        assignCommerceQuantityRule(
          unassigned.state,
          quantityRuleState,
          toTrustedCommerceQuantityAssignmentCommand(conflictingUnassignPayload, trusted, observedAt),
        ),
      ),
    ).toBe(true);

    const repeatedUnassignPayload = Schema.decodeUnknownSync(CommerceQuantityAssignmentPayloadSchema)({
      ...unassignPayload,
      effectiveAt: '2026-12-01T00:00:00.000Z',
      expectedGeneration: 2,
      idempotencyKey: 'unassign-product-rule-again',
    });
    const repeatedUnassign = assignCommerceQuantityRule(
      unassigned.state,
      quantityRuleState,
      toTrustedCommerceQuantityAssignmentCommand(repeatedUnassignPayload, trusted, observedAt),
    );
    expect(Schema.is(InvalidLifecycleTransitionTagSchema)(repeatedUnassign)).toBe(true);

    const adjacentAssignment = assignCommerceQuantityRule(
      unassigned.state,
      quantityRuleState,
      toTrustedCommerceQuantityAssignmentCommand(
        assignmentPayload(
          {
            assignmentId: '66666666-6666-4666-8666-666666666667',
            effectiveFrom: '2026-11-01T00:00:00.000Z',
            idempotencyKey: 'reassign-product-rule',
          },
          2,
        ),
        trusted,
        observedAt,
      ),
    );
    expect(Schema.is(CustomerCommercePolicyChangedTagSchema)(adjacentAssignment)).toBe(true);
  });

  it('returns quantity rule and assignment sets with separate owner completeness evidence', () => {
    const ruleState = {
      commandReceipts: [],
      field: 'COMMERCE_QUANTITY_RULE' as const,
      generation: 7,
      lifecycleTransitions: [],
      revisions: [quantityRule],
    };
    const assignment = assignCommerceQuantityRule(
      emptyQuantityAssignmentSet(),
      quantityRuleState,
      toTrustedCommerceQuantityAssignmentCommand(assignmentPayload(), trusted, observedAt),
    );
    if (!Schema.is(CustomerCommercePolicyChangedTagSchema)(assignment)) {
      throw new Error('expected assignment');
    }

    const current = currentCommerceQuantityPolicySet(ruleState, assignment.state, '2026-10-02T00:00:00.000Z');
    expect(current.ruleSet.candidates).toHaveLength(1);
    expect(current.assignmentSet.assignments).toHaveLength(1);
    expect(current.ruleSet.completeness.ownerRevision).toBe('COMMERCE_QUANTITY_RULE:7');
    expect(current.assignmentSet.completeness.ownerRevision).toBe('COMMERCE_QUANTITY_ASSIGNMENT:1');
  });

  it('publishes strict resolver-facing Current projections without administration metadata', () => {
    const currencyCreated = administerPurchaseCurrencyPolicy(
      emptyCustomerCommercePolicySet('PURCHASE_CURRENCY'),
      createCurrencyCommand(),
    );
    if (!Schema.is(CustomerCommercePolicyChangedTagSchema)(currencyCreated)) {
      throw new Error('expected currency creation');
    }
    const currencyCurrent = currentPurchaseCurrencyPolicySet(currencyCreated.state, '2026-10-02T00:00:00.000Z');
    const [currencyCandidate] = currencyCurrent.candidates;
    if (currencyCandidate === undefined) {
      throw new Error('expected currency candidate');
    }
    expect(Schema.is(CurrentPurchaseCurrencyPolicySetSchema)(currencyCurrent)).toBe(true);
    expect(Object.keys(currencyCandidate)).toEqual([
      'effectiveFrom',
      'effectiveTo',
      'policyRevisionId',
      'scope',
      'value',
    ]);
    for (const leakedField of [
      'actionInvocationId',
      'actorPrincipalId',
      'idempotencyKey',
      'lifecycle',
      'reason',
      'tenantId',
    ] as const) {
      expect(() =>
        Schema.decodeUnknownSync(CurrentPurchaseCurrencyPolicyCandidateSchema)({
          ...currencyCandidate,
          [leakedField]: 'must-not-leak',
        }),
      ).toThrow();
    }

    const paymentTermCandidate = Schema.decodeUnknownSync(CurrentPaymentTermPolicyCandidateSchema)({
      effectiveFrom: '2026-10-01T00:00:00.000Z',
      effectiveTo: null,
      policyRevisionId: '55555555-5555-4555-8555-555555555556',
      scope: revisionPayload.scope,
      value: {
        kind: 'FALLBACK_PAYMENT_TERM',
        paymentTermRef: {
          moduleId: 'payment.term-catalog',
          resourceId: 'net-30',
          resourceType: 'payment.term-catalog.payment-term',
          tenantId,
        },
      },
    });
    expect(() =>
      Schema.decodeUnknownSync(CurrentPaymentTermPolicyCandidateSchema)({
        ...paymentTermCandidate,
        idempotencyKey: 'must-not-leak',
      }),
    ).toThrow();

    const ruleState = {
      commandReceipts: [],
      field: 'COMMERCE_QUANTITY_RULE' as const,
      generation: 1,
      lifecycleTransitions: [],
      revisions: [quantityRule],
    };
    const assigned = assignCommerceQuantityRule(
      emptyQuantityAssignmentSet(),
      quantityRuleState,
      toTrustedCommerceQuantityAssignmentCommand(assignmentPayload(), trusted, observedAt),
    );
    if (!Schema.is(CustomerCommercePolicyChangedTagSchema)(assigned)) {
      throw new Error('expected quantity assignment');
    }
    const quantityCurrent = currentCommerceQuantityPolicySet(ruleState, assigned.state, '2026-10-02T00:00:00.000Z');
    const [ruleCandidate] = quantityCurrent.ruleSet.candidates;
    const [assignment] = quantityCurrent.assignmentSet.assignments;
    if (ruleCandidate === undefined || assignment === undefined) {
      throw new Error('expected quantity Current projections');
    }
    expect(Schema.is(CurrentCommerceQuantityPolicySetSchema)(quantityCurrent)).toBe(true);
    expect(Object.keys(ruleCandidate)).toEqual(['effectiveFrom', 'effectiveTo', 'policyRevisionId', 'scope', 'value']);
    expect(Object.keys(assignment)).toEqual([
      'assignmentId',
      'effectiveFrom',
      'effectiveTo',
      'profile',
      'ruleRevisionRef',
      'sellingLegalEntityId',
    ]);
    expect(() =>
      Schema.decodeUnknownSync(CurrentCommerceQuantityRuleCandidateSchema)({
        ...ruleCandidate,
        reason: 'must not leak',
      }),
    ).toThrow();
    for (const leakedField of [
      'actionInvocationId',
      'actorPrincipalId',
      'idempotencyKey',
      'lifecycle',
      'reason',
      'recordedAt',
    ] as const) {
      expect(() =>
        Schema.decodeUnknownSync(CurrentCommerceQuantityAssignmentSchema)({
          ...assignment,
          [leakedField]: 'must-not-leak',
        }),
      ).toThrow();
    }
  });
});
