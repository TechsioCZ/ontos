import type { ActionServicePreparationContext, ActionServiceFactory } from '@app/core-runtime';
import { OperationContextUnavailable, TrustedPrincipalContextSchema } from '@app/core-runtime';
import { DateTime, Effect, Schema } from 'effect';
import type {
  PreparedPurchaseLimitCurrentness,
  PurchaseLimitEvaluationCurrentFactsSchema,
  PurchaseLimitEvaluationCurrentnessPortService,
} from '../../shared/domain/purchase-limit-evaluation-currentness-port.ts';
import type { PurchaseLimitSourceRevisionVector } from '../../shared/domain/purchase-limit-evaluation.ts';
import { PurchaseLimitDependencyUnavailableSchema } from '../../shared/domain/purchase-limit-policy.ts';
import { PurchaseProposalRevisionSchema } from '../../shared/domain/purchasing-approval.ts';
import { PurchaseValueSchema } from '../../shared/domain/purchase-limit.ts';

const samePrincipal = Schema.toEquivalence(TrustedPrincipalContextSchema);
const sameValue = Schema.toEquivalence(PurchaseValueSchema);
const sameProposal = Schema.toEquivalence(Schema.toType(PurchaseProposalRevisionSchema));
const unavailable = () =>
  PurchaseLimitDependencyUnavailableSchema.make({
    code: 'purchase_limit_dependency_unavailable',
    dependency: 'TEST_EXACT_APPROVAL_SOURCE',
    reason: 'The exact immutable TEST source observation is unavailable, changed or expired',
  });

const sameSourceVector = (sources: PurchaseLimitSourceRevisionVector, expected: ReadonlyMap<string, string>): boolean =>
  sources.length === expected.size && sources.every(({ revision, source }) => expected.get(source) === revision);

/** TEST external owner facts are independently registered before create, not copied from Action claims.
 * This adapter proves the real preflight/commit protocol, not the production CCC basis HTTP chain. */
export const prepareTestApprovalCurrentness = Effect.fn('ApprovalTestCurrentness.prepare')(function* prepare(
  context: ActionServicePreparationContext,
  known: {
    readonly facts: typeof PurchaseLimitEvaluationCurrentFactsSchema.Type;
    readonly proposal: typeof PurchaseProposalRevisionSchema.Type;
    readonly sources: PurchaseLimitSourceRevisionVector;
  },
) {
  const facts = structuredClone(known.facts);
  const { proposal } = known;
  const observedAt = yield* DateTime.now;
  const deadline = Math.min(DateTime.toEpochMillis(proposal.expiresAt), DateTime.toEpochMillis(observedAt) + 30_000);
  const sourceVector = new Map(known.sources.map(({ revision, source }) => [source, revision]));
  const factory: ActionServiceFactory<PreparedPurchaseLimitCurrentness> = (transaction, scope, revision) => {
    if (
      !samePrincipal(scope, context.scope) ||
      scope.correlationId !== context.scope.correlationId ||
      scope.legalEntityId !== context.scope.legalEntityId ||
      scope.trustedStorefrontId !== context.scope.trustedStorefrontId ||
      revision !== context.compositionRevision
    ) {
      return Effect.fail(
        new OperationContextUnavailable({
          code: 'operation_context_unavailable',
          reason: 'The TEST source preparation belongs to another invocation context',
        }),
      );
    }
    const revalidate = Effect.fn('ApprovalTestCurrentness.revalidate')(function* revalidate() {
      const now = yield* DateTime.now;
      if (DateTime.isLessThan(now, observedAt) || DateTime.toEpochMillis(now) >= deadline) {
        return yield* Effect.fail(unavailable());
      }
      return yield* Effect.void;
    });
    const resolve: PurchaseLimitEvaluationCurrentnessPortService['resolveCurrent'] = (query) =>
      revalidate().pipe(
        Effect.andThen(DateTime.now),
        Effect.filterOrFail(
          (now) =>
            query.scope.tenantId === scope.tenantId &&
            query.scope.legalEntityId === scope.legalEntityId &&
            query.scope.principalId === proposal.identity.buyer.principalId &&
            query.scope.storefrontId === proposal.context.storefrontId &&
            query.counterpartyRef.tenantId === proposal.identity.counterpartyRef.tenantId &&
            query.counterpartyRef.resourceId === proposal.identity.counterpartyRef.resourceId &&
            sameValue(query.claimedPurchaseValue, proposal.purchaseValue) &&
            query.expectedSourceRevisions.length === sourceVector.size &&
            sameSourceVector(query.expectedSourceRevisions, sourceVector) &&
            !DateTime.isLessThan(query.observedAt, observedAt) &&
            DateTime.toEpochMillis(query.observedAt) < deadline &&
            !DateTime.isGreaterThan(query.observedAt, now),
          unavailable,
        ),
        Effect.as(facts),
      );
    const invalid: PurchaseLimitEvaluationCurrentnessPortService = { resolveCurrent: () => Effect.fail(unavailable()) };
    const currentness: PurchaseLimitEvaluationCurrentnessPortService = {
      forOperation: (candidate, candidateScope) =>
        Object.is(candidate, transaction) && samePrincipal(candidateScope, scope) ? currentness : invalid,
      forTransaction: (candidate, candidateScope) =>
        Object.is(candidate, transaction) &&
        candidateScope.tenantId === scope.tenantId &&
        candidateScope.legalEntityId === scope.legalEntityId &&
        candidateScope.principalId === proposal.identity.buyer.principalId &&
        candidateScope.storefrontId === proposal.context.storefrontId
          ? currentness
          : invalid,
      resolveCandidate: (query) =>
        query.candidateProposal !== undefined && sameProposal(query.candidateProposal, proposal)
          ? resolve(query)
          : Effect.fail(unavailable()),
      resolveCurrent: resolve,
    };
    return Effect.succeed({ currentness, revalidate });
  };
  return factory;
});
