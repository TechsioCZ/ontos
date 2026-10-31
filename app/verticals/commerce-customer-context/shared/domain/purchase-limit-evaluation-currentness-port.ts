import { Context, Schema } from 'effect';
import type {
  ActionServiceFactory,
  ActionServicePreparationContext,
  OperationalScope,
  ScopedTransactionExecutor,
} from '@app/core-runtime';
import type { PurchaseProposalRevision } from './purchasing-approval.ts';
import type { Effect } from 'effect';

import type { PurchaseLimitCounterpartyRef, PurchaseLimitDependencyUnavailable } from './purchase-limit-policy.ts';
import { PurchaseLimitExternalSourceRevisionVectorSchema } from './purchase-limit-evaluation.ts';
import type {
  PurchaseLimitSourceRevisionVector,
  PurchaseLimitUtcTimestampSchema,
} from './purchase-limit-evaluation.ts';
import { PurchaseValueSchema } from './purchase-limit.ts';
import type { PurchaseValue } from './purchase-limit.ts';

const StableContextIdentifierSchema = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300));
const PurchaseLimitChannelIdSchema = StableContextIdentifierSchema.pipe(Schema.brand('PurchaseLimitChannelId'));
const PurchaseLimitContextRevisionSchema = StableContextIdentifierSchema.pipe(
  Schema.brand('PurchaseLimitContextRevision'),
);
const PurchaseLimitMarketIdSchema = StableContextIdentifierSchema.pipe(Schema.brand('PurchaseLimitMarketId'));

interface PurchaseLimitEvaluationTrustedScope {
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
export type PurchaseLimitEvaluationCurrentFacts = typeof PurchaseLimitEvaluationCurrentFactsSchema.Type;

export interface PreparedPurchaseLimitCurrentness {
  readonly currentness: PurchaseLimitEvaluationCurrentnessPortService;
  readonly revalidate: () => Effect.Effect<void, PurchaseLimitDependencyUnavailable>;
}

export interface PurchaseLimitEvaluationCurrentnessPortService {
  /** Capture the real authenticated operation; a business buyer scope must never be promoted to it. */
  readonly forOperation?: (
    transaction: ScopedTransactionExecutor,
    scope: OperationalScope,
  ) => PurchaseLimitEvaluationCurrentnessPortService;

  /**
   * Close the owner-currentness resolver over the Action transaction. A
   * resolver may omit this when it is already transaction-bound; production
   * adapters should implement it so current facts are read in the same scoped
   * transaction as the evaluation and proposal mutation.
   */
  readonly forTransaction?: <Transaction>(
    transaction: Transaction,
    scope: PurchaseLimitEvaluationTrustedScope,
  ) => PurchaseLimitEvaluationCurrentnessPortService;
  /** Observe this provider outside the business transaction, then recheck its owner state at commit.
   * Actions fail closed when their configured provider does not support released preparation. */
  readonly prepare?: (
    context: ActionServicePreparationContext,
    source: Pick<PurchaseValue, 'sourceRef' | 'sourceRevision'>,
  ) => Effect.Effect<ActionServiceFactory<PreparedPurchaseLimitCurrentness>, PurchaseLimitDependencyUnavailable>;
  /**
   * Candidate-only external facts for the first proposal revision. Implementations must not
   * satisfy this by reading the proposal row that the create routine is about to insert.
   */
  readonly resolveCandidate?: (input: {
    readonly candidateProposal?: PurchaseProposalRevision;
    readonly claimedPurchaseValue: PurchaseValue;
    readonly counterpartyRef: PurchaseLimitCounterpartyRef;
    readonly expectedSourceRevisions: PurchaseLimitSourceRevisionVector;
    readonly observedAt: typeof PurchaseLimitUtcTimestampSchema.Type;
    readonly scope: PurchaseLimitEvaluationTrustedScope;
  }) => Effect.Effect<PurchaseLimitEvaluationCurrentFacts, PurchaseLimitDependencyUnavailable>;
  readonly resolveCurrent: (input: {
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
