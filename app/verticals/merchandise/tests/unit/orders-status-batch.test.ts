// @rstest-environment happy-dom
import { ActionProposalAcceptedSchema } from '@app/core-runtime/http/action-proposal';
import {
  browserNetwork,
  pinTestDocument,
  serveApi,
  shellGatewayIssuer,
} from '@app/shared-contracts/testing/http-double';
import { HttpApiBuilder } from '@modern-js/bff-effect/effect-edge';
import { Effect, Layer, Schema } from 'effect';
import { HttpServerRequest } from 'effect/http';
import { beforeEach, describe, expect, it } from 'effect-rstest';
import { changeOrderStatusActionSchemaErrorLive } from '../../api/change-order-status-action-problems.ts';
import { ApplyCommandResultSchema } from '../../shared/actions/apply-command.ts';
import {
  ChangeOrderStatusActionApi,
  ChangeOrderStatusActionConflictProblemSchema,
} from '../../shared/apis/change-order-status-action.ts';
import type { ChangeOrderStatusPayloadSchema } from '../../shared/apis/change-order-status-action.ts';
import { OrderSchema } from '../../shared/apis/records.ts';
import {
  changeOrderStatuses,
  firstOrdersPage,
  ordersPageData,
} from '../../src/routes/[lang]/prodej/objednavky/orders-records.ts';

type StatusPayload = typeof ChangeOrderStatusPayloadSchema.Encoded;
type StatusResult = typeof ApplyCommandResultSchema.Type | typeof ActionProposalAcceptedSchema.Type;
type Conflict = typeof ChangeOrderStatusActionConflictProblemSchema.Type;

const commands: { readonly idempotencyKey: string; readonly payload: StatusPayload }[] = [];
const responses: Effect.Effect<StatusResult, Conflict>[] = [];
const OwnerActionApi = ChangeOrderStatusActionApi.prefix('/merchandise-api');
const network = browserNetwork(
  shellGatewayIssuer({ merchandise: '/merchandise-api' }).application,
  serveApi(
    OwnerActionApi,
    HttpApiBuilder.group(OwnerActionApi, 'changeOrderStatusAction', (group) =>
      group.handle('execute', ({ payload }) =>
        Effect.gen(function* receiveStatusCommand() {
          const request = yield* HttpServerRequest.HttpServerRequest;
          commands.push({ idempotencyKey: request.headers['idempotency-key'] ?? '', payload });
          return yield* responses.shift() ?? Effect.die('Unexpected order status command');
        }),
      ),
    ).pipe(Layer.provide(changeOrderStatusActionSchemaErrorLive)),
  ),
);

const order = (id: string) =>
  Schema.decodeSync(OrderSchema)({
    createdAt: '2026-10-15T10:00:00Z',
    id,
    lines: [
      { productId: 'product-1', productName: 'Cable', quantity: 1, sku: 'CABLE', unitPriceMinor: 100, vatRate: 21 },
    ],
    number: id,
    partyId: 'party-1',
    status: 'NEW',
    totalMinor: 100,
    totalVatMinor: 21,
    updatedAt: '2026-10-15T10:00:00Z',
  });

beforeEach(() => {
  commands.length = 0;
  responses.length = 0;
});

describe('bulk order status commands', () => {
  it.live('counts mixed outcomes and advances the next revision only after confirmed writes', () =>
    Effect.gen(function* mixedOutcomes() {
      yield* pinTestDocument;
      const conflict = yield* Schema.decodeEffect(ChangeOrderStatusActionConflictProblemSchema)({
        _tag: 'ChangeOrderStatusActionConflictProblem',
        code: 'merchandise_revision_conflict',
        detail: 'The records changed',
        status: 409,
        title: 'Conflict',
        type: 'urn:test:revision-conflict',
      });
      const firstCommit = yield* Schema.decodeEffect(ApplyCommandResultSchema)({
        entityIds: ['order-2'],
        revision: 14,
      });
      const secondCommit = yield* Schema.decodeEffect(ApplyCommandResultSchema)({
        entityIds: ['order-4'],
        revision: 27,
      });
      responses.push(
        Effect.fail(conflict),
        Effect.succeed(firstCommit),
        Effect.fail(conflict),
        Effect.succeed(secondCommit),
      );

      const result = yield* changeOrderStatuses({
        orders: ['order-1', 'order-2', 'order-3', 'order-4'].map(order),
        revision: 10,
        status: 'CONFIRMED',
      });

      expect(result).toEqual({ changed: 2, failed: 2, revision: 27 });
      expect(commands.map(({ payload }) => payload)).toEqual([
        { command: { _tag: 'ChangeOrderStatus', id: 'order-1', status: 'CONFIRMED' }, expectedRevision: 10 },
        { command: { _tag: 'ChangeOrderStatus', id: 'order-2', status: 'CONFIRMED' }, expectedRevision: 10 },
        { command: { _tag: 'ChangeOrderStatus', id: 'order-3', status: 'CONFIRMED' }, expectedRevision: 14 },
        { command: { _tag: 'ChangeOrderStatus', id: 'order-4', status: 'CONFIRMED' }, expectedRevision: 14 },
      ]);
      const keys = commands.map(({ idempotencyKey }) => idempotencyKey);
      expect(keys).toHaveLength(4);
      expect(new Set(keys).size).toBe(4);
      for (const key of keys) {
        expect(key.length).toBeGreaterThan(0);
      }
    }).pipe(Effect.provide(network)),
  );

  it.live('sends the cancellation reason with each status command', () =>
    Effect.gen(function* cancellationReason() {
      yield* pinTestDocument;
      const commit = yield* Schema.decodeEffect(ApplyCommandResultSchema)({ entityIds: ['order-1'], revision: 11 });
      responses.push(Effect.succeed(commit));

      const result = yield* changeOrderStatuses({
        orders: [order('order-1')],
        reason: 'Zákazník objednávku zrušil',
        revision: 10,
        status: 'CANCELLED',
      });

      expect(result).toEqual({ changed: 1, failed: 0, revision: 11 });
      expect(commands.map(({ payload }) => payload)).toEqual([
        {
          command: {
            _tag: 'ChangeOrderStatus',
            id: 'order-1',
            reason: 'Zákazník objednávku zrušil',
            status: 'CANCELLED',
          },
          expectedRevision: 10,
        },
      ]);
    }).pipe(Effect.provide(network)),
  );

  it.live('does not write or advance the revision for an empty selection', () =>
    Effect.gen(function* emptySelection() {
      yield* pinTestDocument;
      const result = yield* changeOrderStatuses({ orders: [], revision: 10, status: 'CONFIRMED' });
      expect(result).toEqual({ changed: 0, failed: 0, revision: 10 });
      expect(commands).toHaveLength(0);
    }).pipe(Effect.provide(network)),
  );
});

it('the first orders page the Shell prepares is the entry the page reads', () => {
  const first = { legalEntityId: 'entity-1', query: firstOrdersPage(50) };
  const key = ordersPageData.key(first);
  // Without a search the customer lookup is not sent, so it does not split the entry.
  expect(ordersPageData.key({ ...first, query: { ...firstOrdersPage(50), customerPartyIds: ['party-1'] } })).toBe(key);
  expect(ordersPageData.key({ ...first, query: { ...firstOrdersPage(50), offset: 50 } })).not.toBe(key);
  expect(ordersPageData.key({ ...first, query: { ...firstOrdersPage(50), status: 'NEW' } })).not.toBe(key);
  expect(ordersPageData.key({ ...first, legalEntityId: 'entity-2' })).not.toBe(key);
});

it.live('pending status proposals preserve their receipts without advancing revision or claiming changed orders', () =>
  Effect.gen(function* pendingBatch() {
    yield* pinTestDocument;
    const receipt = Schema.decodeUnknownSync(ActionProposalAcceptedSchema)({
      _tag: 'ActionProposalAccepted',
      expiresAt: '2026-11-10T12:00:00.000Z',
      proposalId: '60000000-0000-4000-8000-000000000001',
    });
    responses.push(Effect.succeed(receipt), Effect.succeed(receipt));
    const result = yield* changeOrderStatuses({
      orders: [order('pending-1'), order('pending-2')],
      revision: 10,
      status: 'CONFIRMED',
    });
    expect(result).toEqual({ changed: 0, failed: 0, proposals: [receipt, receipt], revision: 10 });
    expect(commands.map(({ payload }) => payload.expectedRevision)).toEqual([10, 10]);
  }).pipe(Effect.provide(network)),
);
