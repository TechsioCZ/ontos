import { Effect, Schema } from 'effect';

import type {
  CurrentPurchaseCurrencyPolicyCandidate,
  CurrentPurchaseCurrencyPolicySet,
} from '../../shared/domain/customer-commerce-policy-administration.ts';
import { currentPurchaseCurrencyPolicySet } from '../../shared/domain/customer-commerce-policy-administration.ts';
import { PurchaseCurrencyConstraintValueSchema } from '../../shared/domain/customer-commerce-policy.ts';
import type { OrdinaryCustomerCommercePolicyScope } from '../../shared/domain/customer-commerce-policy.ts';
import { unavailablePurchaseCurrencyDependency } from '../../shared/domain/purchase-currency-dependency.ts';
import type { PurchaseCurrencyPolicyPortService } from '../../shared/domain/purchase-currency-policy-port.ts';
import { InconsistentPurchaseCurrencyPolicy } from '../../shared/domain/purchase-currency-resolution.ts';
import type {
  CurrencyPolicyDecision,
  PurchaseCurrencyCurrentFacts,
} from '../../shared/domain/purchase-currency-resolution.ts';
import type { CustomerCommercePolicyRepository } from '../persistence/customer-commerce-policy-persistence.ts';

const scopeRank = (scope: OrdinaryCustomerCommercePolicyScope): number => {
  if (scope.kind === 'STOREFRONT_MARKET_CHANNEL_SELLER') {
    return 4;
  }
  if (scope.kind === 'MARKET_CHANNEL_SELLER') {
    return 3;
  }
  if (scope.kind === 'CHANNEL_SELLER') {
    return 2;
  }
  return 1;
};

const scopeMatches = (
  scope: OrdinaryCustomerCommercePolicyScope,
  context: PurchaseCurrencyCurrentFacts['purchasingContext'],
): boolean => {
  if (scope.sellingLegalEntityId !== context.sellingLegalEntityId) {
    return false;
  }
  if (scope.kind === 'SELLER') {
    return true;
  }
  if (scope.channelId !== context.channelId) {
    return false;
  }
  if (scope.kind === 'CHANNEL_SELLER') {
    return true;
  }
  if (scope.commerceMarketId !== context.marketId) {
    return false;
  }
  return scope.kind === 'MARKET_CHANNEL_SELLER' || scope.storefrontId === context.storefrontId;
};

const scopeKey = (scope: OrdinaryCustomerCommercePolicyScope): string => {
  const channel = scope.kind === 'SELLER' ? '' : scope.channelId;
  const market =
    scope.kind === 'MARKET_CHANNEL_SELLER' || scope.kind === 'STOREFRONT_MARKET_CHANNEL_SELLER'
      ? scope.commerceMarketId
      : '';
  const storefront = scope.kind === 'STOREFRONT_MARKET_CHANNEL_SELLER' ? scope.storefrontId : '';
  return `${scope.kind}:${scope.sellingLegalEntityId}:${channel}:${market}:${storefront}`;
};

const candidateKey = (candidate: CurrentPurchaseCurrencyPolicyCandidate): string => {
  const { value } = candidate;
  const encodedValue = `${value.kind}:${value.currencyCode}`;
  return `${scopeKey(candidate.scope)}:${encodedValue}`;
};

const conflict = (reason: string) => InconsistentPurchaseCurrencyPolicy.make({ reason });

type AllowedCurrencyCandidate = CurrentPurchaseCurrencyPolicyCandidate & {
  readonly value: Extract<
    CurrentPurchaseCurrencyPolicyCandidate['value'],
    { readonly kind: 'ALLOWED_CURRENCY_CONSTRAINT' }
  >;
};
type DefaultCurrencyCandidate = CurrentPurchaseCurrencyPolicyCandidate & {
  readonly value: Extract<CurrentPurchaseCurrencyPolicyCandidate['value'], { readonly kind: 'DEFAULT_CURRENCY' }>;
};
type RankedSelection =
  | { readonly error: ReturnType<typeof conflict>; readonly kind: 'CONFLICT' }
  | { readonly kind: 'NONE' }
  | { readonly candidate: DefaultCurrencyCandidate; readonly kind: 'ONE' };

const oneHighestRanked = (candidates: readonly CurrentPurchaseCurrencyPolicyCandidate[]): RankedSelection => {
  const matching = candidates.filter(
    (candidate): candidate is DefaultCurrencyCandidate => candidate.value.kind === 'DEFAULT_CURRENCY',
  );
  if (matching.length === 0) {
    return { kind: 'NONE' };
  }
  const highestRank = Math.max(...matching.map(({ scope }) => scopeRank(scope)));
  const winners = matching.filter(({ scope }) => scopeRank(scope) === highestRank);
  const [winner] = winners;
  return winners.length === 1 && winner !== undefined
    ? { candidate: winner, kind: 'ONE' }
    : { error: conflict('Purchase Currency policy has a same-rank DEFAULT_CURRENCY conflict'), kind: 'CONFLICT' };
};

export const composeCurrentPurchaseCurrencyPolicy = (
  current: CurrentPurchaseCurrencyPolicySet,
  context: PurchaseCurrencyCurrentFacts['purchasingContext'],
  observedAt: string,
): Effect.Effect<
  CurrencyPolicyDecision,
  ReturnType<typeof conflict> | ReturnType<typeof unavailablePurchaseCurrencyDependency>
> => {
  if (
    current.completeness.observedAt !== observedAt ||
    !current.completeness.ownerRevision.startsWith('PURCHASE_CURRENCY:') ||
    current.completeness.scope.predicateRef !== 'commerce.customer-context.policy.purchase_currency.current'
  ) {
    return Effect.fail(
      unavailablePurchaseCurrencyDependency(
        'currency_policy_unavailable',
        'Purchase Currency policy completeness is not Current for the resolution observation',
      ),
    );
  }

  const candidates = current.candidates.filter(({ scope }) => scopeMatches(scope, context));
  if (candidates.length === 0) {
    return Effect.fail(
      unavailablePurchaseCurrencyDependency(
        'currency_policy_unavailable',
        'No complete Current Purchase Currency policy exists for the purchasing context',
      ),
    );
  }
  if (
    new Set(candidates.map(({ policyRevisionId }) => policyRevisionId)).size !== candidates.length ||
    new Set(candidates.map(candidateKey)).size !== candidates.length
  ) {
    return Effect.fail(conflict('Purchase Currency policy contains duplicated Current candidates'));
  }

  const constraints: readonly AllowedCurrencyCandidate[] = candidates.flatMap((candidate) =>
    Schema.is(PurchaseCurrencyConstraintValueSchema)(candidate.value) ? [{ ...candidate, value: candidate.value }] : [],
  );
  if (constraints.length === 0) {
    return Effect.fail(conflict('Purchase Currency policy has no allowed-currency constraint'));
  }
  const constraintSets = Map.groupBy(constraints, ({ scope }) => scopeRank(scope));
  const rankedConstraintSets = [...constraintSets.values()].map(
    (rankCandidates) => new Set(rankCandidates.map(({ value }) => value.currencyCode)),
  );
  const [initialAllowed, ...remainingAllowedSets] = rankedConstraintSets;
  const allowedCurrencies = new Set(initialAllowed);
  for (const rankSet of remainingAllowedSets) {
    for (const currency of allowedCurrencies) {
      if (!rankSet.has(currency)) {
        allowedCurrencies.delete(currency);
      }
    }
  }
  if (allowedCurrencies.size === 0) {
    return Effect.fail(conflict('Purchase Currency non-relaxable constraints have no common allowed currency'));
  }

  const defaultCandidate = oneHighestRanked(candidates);
  if (defaultCandidate.kind === 'CONFLICT') {
    return Effect.fail(defaultCandidate.error);
  }
  if (defaultCandidate.kind === 'NONE') {
    return Effect.fail(conflict('Purchase Currency policy has no unambiguous default'));
  }
  if (defaultCandidate.candidate.value.kind !== 'DEFAULT_CURRENCY') {
    return Effect.fail(conflict('Purchase Currency policy candidate kinds are inconsistent'));
  }
  if (!allowedCurrencies.has(defaultCandidate.candidate.value.currencyCode)) {
    return Effect.fail(conflict('Purchase Currency default is outside the non-relaxable allowed set'));
  }

  const policyRevisionIds = [
    ...constraints.map(({ policyRevisionId }) => policyRevisionId),
    defaultCandidate.candidate.policyRevisionId,
  ].filter((revisionId, index, all) => all.indexOf(revisionId) === index);

  return Effect.succeed({
    allowedCurrencies: [...allowedCurrencies].toSorted(),
    completeness: current.completeness,
    defaultCurrency: defaultCandidate.candidate.value.currencyCode,
    policyRevisionIds,
  });
};

export const purchaseCurrencyPolicyPortForRepository = (
  repository: Pick<CustomerCommercePolicyRepository, 'loadPurchaseCurrencyPolicyState'>,
): PurchaseCurrencyPolicyPortService => ({
  resolveCurrent: ({ context, observedAt }) =>
    repository.loadPurchaseCurrencyPolicyState.pipe(
      Effect.map((state) => currentPurchaseCurrencyPolicySet(state, observedAt)),
      Effect.mapError((cause) =>
        Object.defineProperty(
          unavailablePurchaseCurrencyDependency(
            'currency_policy_unavailable',
            'The Current Purchase Currency policy repository is unavailable',
          ),
          'cause',
          { configurable: true, value: cause },
        ),
      ),
      Effect.flatMap((current) => composeCurrentPurchaseCurrencyPolicy(current, context.purchasingContext, observedAt)),
    ),
});
