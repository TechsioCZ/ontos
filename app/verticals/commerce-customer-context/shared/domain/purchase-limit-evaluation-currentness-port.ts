import { Context, Schema } from 'effect';
import type { Effect } from 'effect';

import type {
  PurchaseLimitCounterpartyRef,
  PurchaseLimitDependencyUnavailable,
} from './purchase-limit-policy.ts';
import { PurchaseLimitExternalSourceRevisionVectorSchema } from './purchase-limit-evaluation.ts';
import type {
  PurchaseLimitSourceRevisionVector,
  PurchaseLimitUtcTimestampSchema,
} from './purchase-limit-evaluation.ts';
import { PurchaseValueSchema } from './purchase-limit.ts';
import type { PurchaseValue } from './purchase-limit.ts';

const StableContextIdentifierSchema = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(300),
);
const PurchaseLimitChannelIdSchema = StableContextIdentifierSchema.pipe(
  Schema.brand('PurchaseLimitChannelId'),
);
const PurchaseLimitContextRevisionSchema = StableContextIdentifierSchema.pipe(
  Schema.brand('PurchaseLimitContextRevision'),
);
const PurchaseLimitMarketIdSchema = StableContextIdentifierSchema.pipe(
  Schema.brand('PurchaseLimitMarketId'),
);

export interface PurchaseLimitEvaluationTrustedScope {
  readonly legalEntityId: string;
  readonly principalId: string;
  readonly storefrontId: string;
  readonly tenantId: string;
}

export const PurchaseLimitEvaluationCurrentFactsSchema = Schema.Struct({
  channelId: PurchaseLimitChannelIdSchema,
  contextRevision: PurchaseLimitContextRevisionSchema,
  currentSourceRevisions: PurchaseLimitExternalSourceRevisionVectorSchema,
  marketId: PurchaseLimitMarketIdSchema,
  purchaseValue: PurchaseValueSchema,
});
export type PurchaseLimitEvaluationCurrentFacts =
  typeof PurchaseLimitEvaluationCurrentFactsSchema.Type;

export interface PurchaseLimitEvaluationCurrentnessPortService {
  /**
   * Close the owner-currentness resolver over the Action transaction. A
   * resolver may omit this when it is already transaction-bound; production
   * adapters should implement it so current facts are read in the same scoped
   * transaction as the evaluation and proposal mutation.
   */
  readonly forTransaction?: (
    transaction: unknown,
    scope: PurchaseLimitEvaluationTrustedScope,
  ) => PurchaseLimitEvaluationCurrentnessPortService;
  readonly resolveCurrent: (input: {
    readonly claimedPurchaseValue: PurchaseValue;
    readonly counterpartyRef: PurchaseLimitCounterpartyRef;
    readonly expectedSourceRevisions: PurchaseLimitSourceRevisionVector;
    readonly observedAt: typeof PurchaseLimitUtcTimestampSchema.Type;
    readonly scope: PurchaseLimitEvaluationTrustedScope;
  }) => Effect.Effect<PurchaseLimitEvaluationCurrentFacts, PurchaseLimitDependencyUnavailable>;
  /**
   * Candidate-only external facts for the first proposal revision. Implementations must not
   * satisfy this by reading the proposal row that the create routine is about to insert.
   */
  readonly resolveCandidate?: (input: {
    readonly claimedPurchaseValue: PurchaseValue;
    readonly counterpartyRef: PurchaseLimitCounterpartyRef;
    readonly expectedSourceRevisions: PurchaseLimitSourceRevisionVector;
    readonly observedAt: typeof PurchaseLimitUtcTimestampSchema.Type;
    readonly scope: PurchaseLimitEvaluationTrustedScope;
  }) => Effect.Effect<PurchaseLimitEvaluationCurrentFacts, PurchaseLimitDependencyUnavailable>;
}

/**
 * Explicit seam for Current Purchase Proposal, purchasing-profile, Storefront, and Customer
 * Commerce Policy facts. Those owners remain authoritative; this module never echoes request facts
 * into trusted evaluation evidence.
 */
export class PurchaseLimitEvaluationCurrentnessPort extends Context.Service<
  PurchaseLimitEvaluationCurrentnessPort,
  PurchaseLimitEvaluationCurrentnessPortService
>()(
  '@app/commerce-customer-context/shared/domain/purchase-limit-evaluation-currentness-port/PurchaseLimitEvaluationCurrentnessPort',
) {}
