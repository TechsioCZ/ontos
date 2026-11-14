import { ActionProposalAcceptedSchema } from '@app/core-runtime/http/action-proposal';
import { ReviewOrderChangesPayloadSchema } from '@app/merchandise/apis/review-order-changes-action';
import { Effect, Predicate, Result, Schema } from 'effect';
import { beforeEach, expect, it, rstest } from 'effect-rstest';

import { sendOrderReview } from '../../src/routes/[lang]/prodej/schvalovani-ai/order-review-command.ts';

const { records, review } = rstest.hoisted(() => ({ records: rstest.fn(), review: rstest.fn() }));
rstest.mock('@app/merchandise/apis/records/client', () => ({ executeRecords: records }));
rstest.mock('@app/merchandise/apis/review-order-changes-action/client', () => ({ executeReviewOrderChanges: review }));

const { command } = Schema.decodeUnknownSync(ReviewOrderChangesPayloadSchema)({
  command: { _tag: 'AiDecideChanges', changeIds: ['change-a'], decision: 'approve' },
  expectedRevision: 0,
});
beforeEach(() => {
  records.mockReset();
  review.mockReset();
  records.mockReturnValue(Effect.succeed({ revision: 7 }));
});

it.effect('sends the human decision to the published narrow client with fresh revision and one native key', () =>
  Effect.gen(function* committedReview() {
    review.mockReturnValue(Effect.succeed({ entityIds: [], revision: 8 }));
    yield* sendOrderReview(command);
    expect(review).toHaveBeenCalledTimes(1);
    const [payload, correlation, options] = review.mock.calls[0] ?? [];
    expect(payload).toEqual({ command, expectedRevision: 7 });
    expect(options).toEqual({ idempotencyKey: correlation });
    expect(records).toHaveBeenCalledWith({ view: { limit: 0, ordersLimit: 0 } }, `${correlation}:revision`);
  }),
);

it.effect('retains a parked proposal as pending, never a committed decision and never an automatic retry', () =>
  Effect.gen(function* parkedReview() {
    const proposal = yield* Schema.decodeUnknownEffect(ActionProposalAcceptedSchema)({
      _tag: 'ActionProposalAccepted',
      expiresAt: '2026-11-08T12:00:00.000Z',
      proposalId: '60000000-0000-4000-8000-000000000001',
    });
    review.mockReturnValue(Effect.succeed(proposal));
    const result = yield* sendOrderReview(command).pipe(Effect.result);
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(Predicate.isTagged(result.failure, 'OrderReviewPendingApproval')).toBe(true);
      expect(result.failure).toMatchObject({
        detail: 'Návrh čeká na schválení. Změny zatím nebyly provedeny.',
        proposalId: proposal.proposalId,
      });
    }
    expect(review).toHaveBeenCalledTimes(1);
    expect(records).toHaveBeenCalledTimes(1);
  }),
);

it.effect('re-reads once for an explicit owner revision conflict but does not replay an indeterminate failure', () =>
  Effect.gen(function* boundedReviewRetry() {
    review.mockReturnValueOnce(
      Effect.fail({
        _tag: 'ReviewOrderChangesActionConflictProblem',
        code: 'merchandise_revision_conflict',
      }),
    );
    review.mockReturnValueOnce(Effect.succeed({ entityIds: [], revision: 9 }));
    records.mockReturnValueOnce(Effect.succeed({ revision: 7 }));
    records.mockReturnValueOnce(Effect.succeed({ revision: 8 }));
    yield* sendOrderReview(command);
    expect(review).toHaveBeenCalledTimes(2);
    expect(review.mock.calls[1]?.[0]).toEqual({ command, expectedRevision: 8 });
    review.mockReset();
    records.mockClear();
    review.mockReturnValue(Effect.fail({ _tag: 'PlatformError' }));
    const result = yield* sendOrderReview(command).pipe(Effect.result);
    expect(Result.isFailure(result)).toBe(true);
    expect(review).toHaveBeenCalledTimes(1);
    expect(records).toHaveBeenCalledTimes(1);
  }),
);
