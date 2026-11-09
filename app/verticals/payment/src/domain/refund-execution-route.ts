import { Data, Match, Option, Result } from 'effect';

import type { PaymentExecutionBinding } from '../../shared/domain/payment-execution-binding.ts';
import type {
  PaymentMethod,
  PaymentSourceAuthorityStatus,
  PaymentSourceFactFamily,
  PaymentSourceKind,
} from '../../shared/domain/payment-vocabulary.ts';
import type { PaymentRefundExecutionRoute, PaymentRefundRouteKind } from '../../shared/domain/refund-contract.ts';

/**
 * Refund execution authority by original collection method (#1150 "Refund execution authority",
 * #1152 "Non-gateway refund execution authority"). Collection authority and refund execution
 * authority stay distinct; a refund executor is a configured `REFUND_EXECUTION` source authority that
 * is ACTIVE and explicitly marked as a refund route. A missing route is explicit: there is no
 * transparent fallback, no account/provider failover and no selection by configuration order.
 *
 * | Original method | Accepted executors, in preference order |
 * |---|---|
 * | ONLINE_GATEWAY | the exact original provider family/account/environment binding (PAYMENT_GATEWAY) |
 * | BANK_TRANSFER_ADVANCE, DEFERRED_INVOICE | BANK_ACCOUNTING |
 * | CASH_ON_DELIVERY | merchant BANK_ACCOUNTING; a carrier is never a reverse-refund rail |
 * | PAY_ON_PICKUP_OR_ON_SITE | LOCAL_POS_OPERATOR, else a BANK_ACCOUNTING or MANUAL_EXTERNAL_REFUND route configured explicitly for pickup |
 *
 * Within each preference tier a route configured for the exact method wins over a method-neutral
 * route; two qualifying routes in the same tier are a configuration conflict.
 */

/** One configured source authority as the route decision needs it. */
export interface PaymentRefundRouteCandidate {
  readonly accountRef: string;
  readonly environment: string;
  readonly factFamily: PaymentSourceFactFamily;
  /** The method the authority is configured for; none means method-neutral. */
  readonly method: Option.Option<PaymentMethod>;
  readonly refundRoute: boolean;
  readonly revision: number;
  readonly sourceAuthorityId: string;
  readonly sourceKind: PaymentSourceKind;
  readonly sourceSystem: string;
  readonly status: PaymentSourceAuthorityStatus;
}

export const PAYMENT_REFUND_ROUTE_UNAVAILABLE_REASONS = [
  /** No ACTIVE configured refund route qualifies for the original method. */
  'NO_CONFIGURED_ROUTE',
  /** The original gateway account/environment has no ACTIVE refund authority; no other account is used. */
  'ORIGINAL_BINDING_UNAVAILABLE',
  /** The stored binding contradicts the Payment method. */
  'BINDING_METHOD_MISMATCH',
] as const;
export type PaymentRefundRouteUnavailableReason = (typeof PAYMENT_REFUND_ROUTE_UNAVAILABLE_REASONS)[number];

export type RefundRouteDecisionCase = Data.TaggedEnum<{
  Ambiguous: { readonly sourceAuthorityIds: readonly string[] };
  Resolved: { readonly route: PaymentRefundExecutionRoute };
  Unavailable: { readonly reason: PaymentRefundRouteUnavailableReason };
}>;
export const RefundRouteDecision = Data.taggedEnum<RefundRouteDecisionCase>();

type CandidateFilter = (candidate: PaymentRefundRouteCandidate) => boolean;

const ROUTE_KIND_BY_SOURCE_KIND = {
  BANK_ACCOUNTING: Option.some('BANK_ACCOUNTING'),
  // A carrier collects COD funds; it is never assumed to be a reverse-refund rail.
  CARRIER: Option.none(),
  LOCAL_POS_OPERATOR: Option.some('LOCAL_POS'),
  MANUAL_EXTERNAL_REFUND: Option.some('MANUAL_EXTERNAL'),
  PAYMENT_GATEWAY: Option.some('ORIGINAL_GATEWAY_BINDING'),
} as const satisfies Record<PaymentSourceKind, Option.Option<PaymentRefundRouteKind>>;

const isUsableRefundRoute: CandidateFilter = (candidate) =>
  candidate.status === 'ACTIVE' && candidate.refundRoute && candidate.factFamily === 'REFUND_EXECUTION';

const configuredFor = (candidate: PaymentRefundRouteCandidate, method: PaymentMethod) =>
  Option.isSome(candidate.method) && candidate.method.value === method;

/** Exact-method routes first, then method-neutral routes of the same executor kinds. */
const methodTiers = (method: PaymentMethod, accepts: CandidateFilter): readonly CandidateFilter[] => [
  (candidate) => accepts(candidate) && configuredFor(candidate, method),
  (candidate) => accepts(candidate) && Option.isNone(candidate.method),
];

const sourceKindIn =
  (...kinds: readonly PaymentSourceKind[]): CandidateFilter =>
  (candidate) =>
    kinds.includes(candidate.sourceKind);

type RouteTiers = Result.Result<readonly CandidateFilter[], PaymentRefundRouteUnavailableReason>;

/** The exact original gateway account and environment; credentials rotation never changes them. */
const gatewayTiers = (binding: PaymentExecutionBinding): RouteTiers =>
  Match.valueTags(binding, {
    BANK_ACCOUNTING_RECEIPT: (): RouteTiers => Result.fail('BINDING_METHOD_MISMATCH'),
    COD_DELIVERY_OFFER: (): RouteTiers => Result.fail('BINDING_METHOD_MISMATCH'),
    GATEWAY_ACCOUNT: (gateway): RouteTiers =>
      Result.succeed(
        methodTiers(
          'ONLINE_GATEWAY',
          (candidate) =>
            candidate.sourceKind === 'PAYMENT_GATEWAY' &&
            candidate.sourceSystem === gateway.providerFamily &&
            candidate.accountRef === gateway.providerAccountRef &&
            candidate.environment === gateway.environment,
        ),
      ),
    PICKUP_CAPABILITY: (): RouteTiers => Result.fail('BINDING_METHOD_MISMATCH'),
  });

const tiersFor = (method: PaymentMethod, binding: PaymentExecutionBinding): RouteTiers =>
  Match.value(method).pipe(
    Match.when('ONLINE_GATEWAY', () => gatewayTiers(binding)),
    Match.whenOr('BANK_TRANSFER_ADVANCE', 'CASH_ON_DELIVERY', 'DEFERRED_INVOICE', (merchantMethod): RouteTiers =>
      Result.succeed(methodTiers(merchantMethod, sourceKindIn('BANK_ACCOUNTING'))),
    ),
    Match.when('PAY_ON_PICKUP_OR_ON_SITE', (pickup): RouteTiers =>
      Result.succeed([
        ...methodTiers(pickup, sourceKindIn('LOCAL_POS_OPERATOR')),
        // The fallback must be explicitly authorized for pickup; a method-neutral route never qualifies.
        (candidate) =>
          sourceKindIn('BANK_ACCOUNTING', 'MANUAL_EXTERNAL_REFUND')(candidate) && configuredFor(candidate, pickup),
      ]),
    ),
    Match.exhaustive,
  );

const routeOf = (candidate: PaymentRefundRouteCandidate): RefundRouteDecisionCase =>
  Option.match(ROUTE_KIND_BY_SOURCE_KIND[candidate.sourceKind], {
    onNone: () => RefundRouteDecision.Unavailable({ reason: 'NO_CONFIGURED_ROUTE' }),
    onSome: (routeKind) =>
      RefundRouteDecision.Resolved({
        route: {
          accountRef: candidate.accountRef,
          environment: candidate.environment,
          routeKind,
          sourceAuthorityId: candidate.sourceAuthorityId,
          sourceAuthorityRevision: candidate.revision,
          sourceKind: candidate.sourceKind,
          sourceSystem: candidate.sourceSystem,
        },
      }),
  });

const decideWithinTiers = (
  method: PaymentMethod,
  tiers: readonly CandidateFilter[],
  candidates: readonly PaymentRefundRouteCandidate[],
): RefundRouteDecisionCase => {
  const usable = candidates.filter(isUsableRefundRoute);
  for (const tier of tiers) {
    const matches = usable.filter(tier);
    const [only] = matches;
    if (matches.length > 1) {
      return RefundRouteDecision.Ambiguous({
        sourceAuthorityIds: matches.map((candidate) => candidate.sourceAuthorityId).toSorted(),
      });
    }
    if (only !== undefined) {
      return routeOf(only);
    }
  }
  return RefundRouteDecision.Unavailable({
    reason: method === 'ONLINE_GATEWAY' ? 'ORIGINAL_BINDING_UNAVAILABLE' : 'NO_CONFIGURED_ROUTE',
  });
};

/** Selects the one governed refund executor for the original method and binding, or refuses explicitly. */
export const decideRefundExecutionRoute = (input: {
  readonly binding: PaymentExecutionBinding;
  readonly candidates: readonly PaymentRefundRouteCandidate[];
  readonly method: PaymentMethod;
}): RefundRouteDecisionCase =>
  Result.match(tiersFor(input.method, input.binding), {
    onFailure: (reason) => RefundRouteDecision.Unavailable({ reason }),
    onSuccess: (tiers) => decideWithinTiers(input.method, tiers, input.candidates),
  });
