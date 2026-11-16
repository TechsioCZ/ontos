import { ActionProposalAcceptedSchema } from '@app/core-runtime/http/action-proposal';
import { executeRecords } from '@app/merchandise/apis/records/client';
import { executeReviewOrderChanges } from '@app/merchandise/apis/review-order-changes-action/client';
import { Effect, Match, Random, Schema } from 'effect';

export class OrderReviewPendingApproval extends Schema.TaggedError<OrderReviewPendingApproval>()(
  'OrderReviewPendingApproval',
  { detail: Schema.String, proposalId: ActionProposalAcceptedSchema.fields.proposalId },
) {}

export const sendOrderReview = Effect.fn('SalesPipeline.sendAiOrderCommand')(
  function* sendOrderReview(command: Parameters<typeof executeReviewOrderChanges>[0]['command']) {
    const nonce = yield* Random.nextInt;
    const key = `sales-pipeline:ai:orders-command:${nonce}`;
    const { revision } = yield* executeRecords({ view: { limit: 0, ordersLimit: 0 } }, `${key}:revision`);
    const result = yield* executeReviewOrderChanges({ command, expectedRevision: revision }, key, {
      idempotencyKey: key,
    });
    if (Schema.is(ActionProposalAcceptedSchema)(result)) {
      return yield* new OrderReviewPendingApproval({
        detail: 'Návrh čeká na schválení. Změny zatím nebyly provedeny.',
        proposalId: result.proposalId,
      });
    }
    return yield* Effect.void;
  },
  // Storefront orders can advance the revision: re-read once only after an explicit owner conflict.
  Effect.retry({
    times: 1,
    while: (error) =>
      Match.value(error).pipe(
        Match.tag(
          'ReviewOrderChangesActionConflictProblem',
          (problem) => problem.code === 'merchandise_revision_conflict',
        ),
        Match.orElse(() => false),
      ),
  }),
);
