import { MerchandiseLifecycleConflict } from '../../shared/errors/merchandise-lifecycle-conflict.ts';
import { ManageCatalogActionConflictProblemSchema } from '../../shared/apis/manage-catalog-action.ts';
import { mapReviewOrderChangesActionProblem } from '../../api/review-order-changes-action-problems.ts';
import { mapProposeOrderChangesActionProblem } from '../../api/propose-order-changes-action-problems.ts';
import { mapPlaceStorefrontOrderActionProblem } from '../../api/place-storefront-order-action-problems.ts';
import { mapChangeOrderStatusActionProblem } from '../../api/change-order-status-action-problems.ts';
import { mapRecordStockMovementActionProblem } from '../../api/record-stock-movement-action-problems.ts';
import { mapChangeProductImagesActionProblem } from '../../api/change-product-images-action-problems.ts';
import { mapCleanupDemoActionProblem } from '../../api/cleanup-demo-action-problems.ts';
import { mapManageMarketsActionProblem } from '../../api/manage-markets-action-problems.ts';
import { mapManageCatalogActionProblem } from '../../api/manage-catalog-action-problems.ts';
import { mapApplyCommandActionProblem } from '../../api/apply-command-action-problems.ts';
import { MerchandiseNotImplementedProblemSchema } from '../../shared/merchandise-action-problems.ts';
import { MerchandiseNotImplemented } from '../../shared/errors/merchandise-not-implemented.ts';
import { DateTime, Effect, Option, Schema } from 'effect';
import { FetchHttpClient } from 'effect/http';
import type { ActionTestHarnessOptions } from '@app/core-runtime/testing/actions';
import { ProposalIdSchema } from '@app/core-runtime/access/ids';
import { ActionProposalAcceptedSchema } from '@app/core-runtime/http/action-proposal';
import { executeManageCatalogWithAuthorization } from '../../src/api/manage-catalog-action-client.ts';
import { ManageCatalogPayloadSchema } from '../../shared/actions/apply-command.ts';
import { expect, it } from 'effect-rstest';
import { cases, makeFixture } from './registered-action-http-fixture.ts';

const id = '50000000-0000-4000-8000-000000000001';

for (const { command, slug } of cases) {
  it.effect(`${slug} publishes its own closed HTTP route and commits the same audit action key`, () =>
    Effect.scoped(
      Effect.gen(function* httpIdentity() {
        const { harness, request, writes } = yield* makeFixture();
        const response = yield* request(`/merchandise/actions/${slug}`, command, slug);
        expect(response.status).toBe(200);
        expect(yield* Effect.promise(() => response.json())).toMatchObject({ revision: 2 });
        expect(harness.snapshot().committed).toHaveLength(1);
        expect(harness.snapshot().invocations[0]?.actionKey).toBe(`demo.merchandise.${slug}`);
        expect(harness.snapshot().committed[0]?.actionKey).toBe(`demo.merchandise.${slug}`);
        expect(writes.at(-1)).toEqual(command);
        const replay = yield* request(`/merchandise/actions/${slug}`, command, slug);
        expect(replay.status).toBe(409);
        expect(harness.snapshot().committed).toHaveLength(1);
        if (slug !== 'apply-command') {
          const rejected = yield* request('/merchandise/actions/apply-command', command, `${slug}-old`);
          expect(rejected.status).toBe(400);
          expect(harness.snapshot().invocations).toHaveLength(1);
        }
        return response.status;
      }),
    ),
  );
}

it.effect(
  'a parked HTTP 202 preserves its actual narrow registration, payload and receipt without a business commit',
  () =>
    Effect.scoped(
      Effect.gen(function* pendingReceipt() {
        const parks: Parameters<NonNullable<ActionTestHarnessOptions['mandateDispatch']>['parkProposal']>[0][] = [];
        const parked = {
          expiresAt: DateTime.toDateUtc(DateTime.makeUnsafe('2026-11-10T12:00:00.000Z')),
          proposalId: ProposalIdSchema.make('60000000-0000-4000-8000-000000000001'),
        };
        const { compositionRevision, harness, requestContext, router } = yield* makeFixture({
          access: 'needs_approval',
          mandateDispatch: {
            claim: () => Effect.die('A proposal cannot claim a mandate'),
            commit: () => Effect.die('A proposal cannot commit a mandate'),
            loadParkedProposal: () => Effect.succeed(Option.none()),
            parkProposal: (input) => {
              parks.push(input);
              return Effect.succeed(parked);
            },
            prepare: () => Effect.die('A proposal cannot execute a mandate'),
          },
        });
        const command = { _tag: 'UpdateProduct', id, patch: { name: 'Pending' } } as const;
        const statuses: number[] = [];
        const receipt = yield* executeManageCatalogWithAuthorization(
          Schema.decodeUnknownSync(ManageCatalogPayloadSchema)({ command, expectedRevision: 1 }),
          'Bearer fixture',
          'pending-update',
          {
            baseUrl: 'https://owner.test',
            compositionRevision,
            idempotencyKey: 'pending-update',
            intent: 'propose',
          },
        ).pipe(
          Effect.provideService(FetchHttpClient.Fetch, async (input, init) => {
            const response = await router.handler(new Request(input, init), requestContext);
            statuses.push(response.status);
            return response;
          }),
        );
        expect(statuses).toEqual([202]);
        expect(Schema.is(ActionProposalAcceptedSchema)(receipt)).toBe(true);
        if (!Schema.is(ActionProposalAcceptedSchema)(receipt)) {
          expect.unreachable('Expected a real proposal receipt');
        }
        expect(receipt.proposalId).toBe(parked.proposalId);
        expect(DateTime.toEpochMillis(receipt.expiresAt)).toBe(parked.expiresAt.getTime());
        expect(parks).toHaveLength(1);
        expect(parks[0]?.actionKey).toBe('demo.merchandise.manage-catalog');
        expect(parks[0]?.capabilityKey).toBe('demo.merchandise.catalog.manage');
        expect(parks[0]?.target).toBeUndefined();
        expect(parks[0]?.payload).toEqual({ command, expectedRevision: 1 });
        expect(harness.snapshot().committed).toEqual([]);
        expect(harness.snapshot().stages).not.toContain('handler_executed');
      }),
    ),
);

it('all actual Merchandise domain problem mappers retain the declared 503 without exposing domain reasons', () => {
  const failure = new MerchandiseNotImplemented({
    code: 'merchandise_not_implemented',
    reason: 'unsafe implementation detail',
  });
  expect(Schema.resolveAnnotationsKey(MerchandiseNotImplementedProblemSchema)?.httpApiStatus).toBe(503);
  for (const map of [
    mapApplyCommandActionProblem,
    mapManageCatalogActionProblem,
    mapManageMarketsActionProblem,
    mapCleanupDemoActionProblem,
    mapChangeProductImagesActionProblem,
    mapRecordStockMovementActionProblem,
    mapChangeOrderStatusActionProblem,
    mapPlaceStorefrontOrderActionProblem,
    mapProposeOrderChangesActionProblem,
    mapReviewOrderChangesActionProblem,
  ]) {
    const problem = map(failure);
    expect(Schema.is(MerchandiseNotImplementedProblemSchema)(problem)).toBe(true);
    expect(problem.status).toBe(503);
    expect(problem.detail).not.toContain('unsafe');
  }
});

for (const code of [
  'merchandise_stock_reconciliation_required',
  'merchandise_variant_bulk_price_unsupported',
  'merchandise_variant_sku_required',
  'merchandise_category_slug_taken',
  'merchandise_tier_base_price_required',
] as const) {
  it(`preserves the actionable ${code} refusal across the typed HTTP problem boundary`, () => {
    const failure = new MerchandiseLifecycleConflict({ code, reason: 'private owner detail' });
    expect(Schema.is(MerchandiseLifecycleConflict)(failure)).toBe(true);
    const problem = mapManageCatalogActionProblem(failure);
    expect(Schema.is(ManageCatalogActionConflictProblemSchema)(problem)).toBe(true);
    expect(problem).toMatchObject({ code, status: 409 });
    expect(problem.detail).not.toContain(failure.reason);
  });
}
