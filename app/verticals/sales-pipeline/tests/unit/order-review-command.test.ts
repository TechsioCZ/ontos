// @rstest-environment happy-dom
import { ActionProposalAcceptedSchema } from '@app/core-runtime/http/action-proposal';
import { RecordsApi, RecordsResponseSchema } from '@app/merchandise/apis/records';
import type { RecordsRequest } from '@app/merchandise/apis/records';
import {
  ReviewOrderChangesActionApi,
  ReviewOrderChangesActionCommitIndeterminateProblemSchema,
  ReviewOrderChangesActionConflictProblemSchema,
  ReviewOrderChangesPayloadSchema,
} from '@app/merchandise/apis/review-order-changes-action';
import type { ReviewOrderChangesActionProblem } from '@app/merchandise/apis/review-order-changes-action';
import { ApplyCommandResultSchema } from '@app/merchandise/contracts/apply-command';
import {
  browserNetwork,
  pinTestDocument,
  serveApi,
  shellGatewayIssuer,
} from '@app/shared-contracts/testing/http-double';
import { HttpApiBuilder, HttpServerRequest } from '@modern-js/bff-effect/effect-edge';
import { Effect, Layer, Predicate, Result, Schema } from 'effect';
import { beforeEach, expect, it } from 'effect-rstest';

import { reviewOrderChangesActionSchemaErrorLive } from '../../../merchandise/api/review-order-changes-action-problems.ts';
import { sendOrderReview } from '../../src/routes/[lang]/prodej/schvalovani-ai/order-review-command.ts';

const records: { readonly correlation: string | undefined; readonly payload: RecordsRequest }[] = [];
const review: {
  readonly correlation: string | undefined;
  readonly idempotencyKey: string | undefined;
  readonly payload: typeof ReviewOrderChangesPayloadSchema.Encoded;
}[] = [];

const recordsResponse = (revision: number) =>
  Schema.decodeUnknownSync(RecordsResponseSchema)({
    actorPrincipalRef: {
      principalId: '20000000-0000-4000-8000-000000000002',
      tenantId: '20000000-0000-4000-8000-000000000001',
    },
    canWrite: false,
    indicators: { lowStockCount: 0, openOrderValueMinor: 0, orderCount: 0, productCount: 0, stockValueMinor: 0 },
    movements: [],
    orders: [],
    products: [],
    revision,
  });

let recordsAnswer: Effect.Effect<typeof RecordsResponseSchema.Type>;
let reviewAnswer: Effect.Effect<
  typeof ApplyCommandResultSchema.Type | typeof ActionProposalAcceptedSchema.Type,
  ReviewOrderChangesActionProblem
>;

const OwnerRecordsApi = RecordsApi.prefix('/merchandise-api');
const OwnerReviewApi = ReviewOrderChangesActionApi.prefix('/merchandise-api');
const network = browserNetwork(
  shellGatewayIssuer({ merchandise: '/merchandise-api' }).application,
  serveApi(
    OwnerRecordsApi,
    HttpApiBuilder.group(OwnerRecordsApi, 'records', (group) =>
      group.handle('execute', ({ payload }) =>
        Effect.gen(function* receiveRecords() {
          const request = yield* HttpServerRequest.HttpServerRequest;
          records.push({ correlation: request.headers['x-correlation-id'], payload });
          return yield* recordsAnswer;
        }),
      ),
    ),
  ),
  serveApi(
    OwnerReviewApi,
    HttpApiBuilder.group(OwnerReviewApi, 'reviewOrderChangesAction', (group) =>
      group.handle('execute', ({ payload }) =>
        Effect.gen(function* receiveReview() {
          const request = yield* HttpServerRequest.HttpServerRequest;
          review.push({
            correlation: request.headers['x-correlation-id'],
            idempotencyKey: request.headers['idempotency-key'],
            payload,
          });
          return yield* reviewAnswer;
        }),
      ),
    ).pipe(Layer.provide(reviewOrderChangesActionSchemaErrorLive)),
  ),
);

const { command } = Schema.decodeUnknownSync(ReviewOrderChangesPayloadSchema)({
  command: { _tag: 'AiDecideChanges', changeIds: ['change-a'], decision: 'approve' },
  expectedRevision: 0,
});
beforeEach(() => {
  records.length = 0;
  review.length = 0;
  recordsAnswer = Effect.succeed(recordsResponse(7));
  reviewAnswer = Effect.succeed(ApplyCommandResultSchema.make({ entityIds: [], revision: 8 }));
});

it.live('sends the human decision to the published narrow client with fresh revision and one native key', () =>
  Effect.gen(function* committedReview() {
    yield* pinTestDocument;
    yield* sendOrderReview(command);
    expect(review).toHaveLength(1);
    const [received] = review;
    expect(received?.payload).toEqual({ command, expectedRevision: 7 });
    expect(received?.correlation).toEqual(expect.any(String));
    expect({ idempotencyKey: received?.idempotencyKey }).toEqual({ idempotencyKey: received?.correlation });
    expect(records).toContainEqual({
      correlation: `${received?.correlation}:revision`,
      payload: { view: { limit: 0, ordersLimit: 0 } },
    });
  }).pipe(Effect.provide(network)),
);

it.live('retains a parked proposal as pending, never a committed decision and never an automatic retry', () =>
  Effect.gen(function* parkedReview() {
    yield* pinTestDocument;
    const proposal = yield* Schema.decodeUnknownEffect(ActionProposalAcceptedSchema)({
      _tag: 'ActionProposalAccepted',
      expiresAt: '2026-11-08T12:00:00.000Z',
      proposalId: '60000000-0000-4000-8000-000000000001',
    });
    reviewAnswer = Effect.succeed(proposal);
    const result = yield* sendOrderReview(command).pipe(Effect.result);
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(Predicate.isTagged(result.failure, 'OrderReviewPendingApproval')).toBe(true);
      expect(result.failure).toMatchObject({
        detail: 'Návrh čeká na schválení. Změny zatím nebyly provedeny.',
        proposalId: proposal.proposalId,
      });
    }
    expect(review).toHaveLength(1);
    expect(records).toHaveLength(1);
  }).pipe(Effect.provide(network)),
);

it.live('re-reads once for an explicit owner revision conflict but does not replay an indeterminate failure', () =>
  Effect.gen(function* boundedReviewRetry() {
    yield* pinTestDocument;
    reviewAnswer = Effect.suspend(() =>
      review.length === 1
        ? Effect.fail(
            ReviewOrderChangesActionConflictProblemSchema.make({
              code: 'merchandise_revision_conflict',
              detail: 'The order revision changed.',
              status: 409,
              title: 'Action conflict',
              type: 'https://ontos.dev/problems/action-conflict',
            }),
          )
        : Effect.succeed(ApplyCommandResultSchema.make({ entityIds: [], revision: 9 })),
    );
    recordsAnswer = Effect.sync(() => recordsResponse(records.length === 1 ? 7 : 8));
    yield* sendOrderReview(command);
    expect(review).toHaveLength(2);
    expect(review[1]?.payload).toEqual({ command, expectedRevision: 8 });
    review.length = 0;
    records.length = 0;
    reviewAnswer = Effect.fail(
      ReviewOrderChangesActionCommitIndeterminateProblemSchema.make({
        detail: 'Resolve this invocation before another attempt.',
        invocationId: '60000000-0000-4000-8000-000000000002',
        resolution: 'RESOLVE_COMMIT',
        retryCommand: false,
        status: 503,
        title: 'Action commit uncertain',
        type: 'https://ontos.dev/problems/action-commit-indeterminate',
      }),
    );
    const result = yield* sendOrderReview(command).pipe(Effect.result);
    expect(Result.isFailure(result)).toBe(true);
    expect(review).toHaveLength(1);
    expect(records).toHaveLength(1);
  }).pipe(Effect.provide(network)),
);
