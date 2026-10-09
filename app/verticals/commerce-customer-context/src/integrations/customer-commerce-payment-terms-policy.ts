import { Effect } from 'effect';

import type {
  CustomerCommercePolicyAdministrationRejected,
  CurrentPaymentTermPolicyCandidate,
  CurrentPaymentTermPolicySet,
} from '../../shared/domain/customer-commerce-policy-administration.ts';
import type { PaymentTermReference } from '../../shared/domain/payment-term-contracts.ts';
import type {
  CustomerCommercePaymentTermsPolicyContext,
  PaymentTermsPolicyResolution,
} from '../../shared/domain/payment-terms.ts';
import type { PaymentTermsDependencyUnavailable } from '../../shared/domain/payment-term-errors.ts';
import { PaymentTermsDependencyUnavailable as PaymentTermsDependencyUnavailableError } from '../../shared/domain/payment-term-errors.ts';

type PaymentTermPolicyRequest = Readonly<{
  at: string;
  purchasingContext: CustomerCommercePaymentTermsPolicyContext['purchasingContext'];
}>;

export type CurrentPaymentTermPolicyReader = Readonly<{
  readCurrentPaymentTermPolicy: (
    at: string,
  ) => Effect.Effect<CurrentPaymentTermPolicySet, CustomerCommercePolicyAdministrationRejected>;
}>;

export type CustomerCommercePaymentTermsPolicyResolver = Readonly<{
  resolve: (
    input: PaymentTermPolicyRequest,
  ) => Effect.Effect<PaymentTermsPolicyResolution, PaymentTermsDependencyUnavailable>;
}>;

const referenceKey = (reference: PaymentTermReference): string =>
  `${reference.tenantId}:${reference.moduleId}:${reference.resourceType}:${reference.resourceId}`;

const unavailable = (cause: unknown): PaymentTermsDependencyUnavailable => {
  const failure = new PaymentTermsDependencyUnavailableError({
    code: 'payment_terms_dependency_unavailable',
    dependency: 'CUSTOMER_COMMERCE_POLICY',
    reason: 'The Current Customer Commerce Payment Terms Policy could not be resolved',
  });
  Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
  return failure;
};

const policyFailure = (
  tag:
    | 'BROKEN_PAYMENT_TERM_POLICY'
    | 'INCONSISTENT_PAYMENT_TERM_POLICY'
    | 'MISSING_PAYMENT_TERM_POLICY'
    | 'PAYMENT_TERM_POLICY_UNVERIFIABLE',
  reason: string,
): PaymentTermsPolicyResolution => ({ _tag: tag, reason });

const scopeRank = (
  candidate: CurrentPaymentTermPolicyCandidate,
  context: CustomerCommercePaymentTermsPolicyContext,
): 0 | 1 | 2 | 3 | 4 => {
  const { scope } = candidate;
  if (scope.sellingLegalEntityId !== context.purchasingContext.sellingLegalEntityId) {
    return 0;
  }
  if (scope.kind === 'SELLER') {
    return 1;
  }
  if (scope.channelId !== context.purchasingContext.channelId) {
    return 0;
  }
  if (scope.kind === 'CHANNEL_SELLER') {
    return 2;
  }
  if (scope.commerceMarketId !== context.purchasingContext.marketId) {
    return 0;
  }
  if (scope.kind === 'MARKET_CHANNEL_SELLER') {
    return 3;
  }
  return scope.storefrontId === context.trustedStorefrontId ? 4 : 0;
};

type WinningValue<Value> = Readonly<{ conflict: false; value?: Value }> | Readonly<{ conflict: true }>;

const oneWinningValue = <Value>(
  ranked: readonly Readonly<{ rank: number; value: Value }>[],
  key: (value: Value) => string,
): WinningValue<Value> => {
  let winningRank = 0;
  for (const candidate of ranked) {
    winningRank = Math.max(winningRank, candidate.rank);
  }
  const values = new Map<string, Value>();
  for (const candidate of ranked) {
    if (candidate.rank === winningRank) {
      values.set(key(candidate.value), candidate.value);
    }
  }
  const [value] = values.values();
  if (values.size > 1) {
    return { conflict: true };
  }
  return value === undefined ? { conflict: false } : { conflict: false, value };
};

const applicableReferences = (
  ranked: readonly Readonly<{ candidate: CurrentPaymentTermPolicyCandidate; rank: number }>[],
): readonly PaymentTermReference[] => {
  const byRank = new Map<number, Map<string, PaymentTermReference>>();
  for (const { candidate, rank } of ranked) {
    if (candidate.value.kind !== 'APPLICABLE_PAYMENT_TERM_CONSTRAINT') {
      continue;
    }
    const references = byRank.get(rank) ?? new Map<string, PaymentTermReference>();
    references.set(referenceKey(candidate.value.paymentTermRef), candidate.value.paymentTermRef);
    byRank.set(rank, references);
  }
  const ranks = [...byRank.keys()].toSorted((left, right) => left - right);
  let applicable: Map<string, PaymentTermReference> | undefined;
  for (const rank of ranks) {
    const references = byRank.get(rank);
    if (references === undefined) {
      continue;
    }
    applicable =
      applicable === undefined
        ? new Map(references)
        : new Map([...applicable].filter(([reference]) => references.has(reference)));
  }
  return applicable === undefined ? [] : [...applicable.values()];
};

export const resolveCurrentCustomerCommercePaymentTermsPolicy = (
  policySet: CurrentPaymentTermPolicySet,
  context: CustomerCommercePaymentTermsPolicyContext,
): PaymentTermsPolicyResolution => {
  if (context.purchasingContext.storefrontId !== context.trustedStorefrontId) {
    return policyFailure(
      'INCONSISTENT_PAYMENT_TERM_POLICY',
      'The purchasing context does not match the trusted Storefront',
    );
  }
  const { completeness } = policySet;
  if (
    completeness.observedAt !== context.at ||
    (completeness.nextApplicabilityBoundary !== undefined && completeness.nextApplicabilityBoundary <= context.at)
  ) {
    return policyFailure(
      'PAYMENT_TERM_POLICY_UNVERIFIABLE',
      'Payment Term policy completeness evidence is not Current for the resolution instant',
    );
  }
  const ranked = policySet.candidates.flatMap((candidate) => {
    const rank = scopeRank(candidate, context);
    return rank === 0 ? [] : [{ candidate, rank }];
  });
  if (ranked.length === 0) {
    return policyFailure('MISSING_PAYMENT_TERM_POLICY', 'No Current Payment Term policy applies to the purchase scope');
  }

  const eligiblePaymentTermRefs = applicableReferences(ranked);
  if (eligiblePaymentTermRefs.length === 0) {
    return policyFailure(
      'MISSING_PAYMENT_TERM_POLICY',
      'No complete Payment Term applicability constraint applies to the purchase scope',
    );
  }
  const eligibleKeys = new Set(eligiblePaymentTermRefs.map(referenceKey));
  const fallback = oneWinningValue(
    ranked.flatMap(({ candidate, rank }) =>
      candidate.value.kind === 'FALLBACK_PAYMENT_TERM' ? [{ rank, value: candidate.value.paymentTermRef }] : [],
    ),
    referenceKey,
  );
  if (fallback.conflict) {
    return policyFailure('INCONSISTENT_PAYMENT_TERM_POLICY', 'Several same-rank Payment Term fallbacks apply');
  }
  const explicitPolicy = oneWinningValue(
    ranked.flatMap(({ candidate, rank }) =>
      candidate.value.kind === 'EXPLICIT_PAYMENT_TERM_CHOICE_POLICY' ? [{ rank, value: candidate.value.enabled }] : [],
    ),
    String,
  );
  if (explicitPolicy.conflict) {
    return policyFailure('INCONSISTENT_PAYMENT_TERM_POLICY', 'Several same-rank explicit-choice policies conflict');
  }
  if (fallback.value !== undefined && !eligibleKeys.has(referenceKey(fallback.value))) {
    return policyFailure(
      'BROKEN_PAYMENT_TERM_POLICY',
      'The selected Payment Term fallback is outside policy applicability',
    );
  }
  return {
    eligiblePaymentTermRefs,
    explicitlyPermittedPaymentTermRefs: explicitPolicy.value === true ? eligiblePaymentTermRefs : [],
    fallbackPaymentTermRefs: fallback.value === undefined ? [] : [fallback.value],
    policyRevision: completeness.ownerRevision,
    policySource: 'commerce.customer-context/payment-term-policy-current',
  };
};

export const customerCommercePaymentTermsPolicyResolver = (
  audience: CustomerCommercePaymentTermsPolicyContext['audience'],
  trustedScope: Readonly<{ tenantId: string; trustedStorefrontId: string }>,
  // oxlint-disable-next-line effect-native/no-dependency-parameters -- Owner-local policy reader is the narrow private seam used by persistence and focused tests.
  reader: CurrentPaymentTermPolicyReader,
): CustomerCommercePaymentTermsPolicyResolver => ({
  resolve: (input) =>
    reader.readCurrentPaymentTermPolicy(input.at).pipe(
      Effect.mapError(unavailable),
      Effect.map((policySet) =>
        resolveCurrentCustomerCommercePaymentTermsPolicy(policySet, {
          at: input.at,
          audience,
          purchasingContext: input.purchasingContext,
          tenantId: trustedScope.tenantId,
          trustedStorefrontId: trustedScope.trustedStorefrontId,
        }),
      ),
    ),
});
