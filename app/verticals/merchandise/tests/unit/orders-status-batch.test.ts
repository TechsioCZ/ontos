import { Effect, Schema } from 'effect';
import { beforeEach, describe, expect, it, rstest } from 'effect-rstest';
import { ApplyCommandResultSchema } from '../../shared/actions/apply-command.ts';
import { ApplyCommandActionConflictProblemSchema } from '../../shared/apis/apply-command-action.ts';
import { OrderSchema } from '../../shared/apis/records.ts';
import { executeApplyCommand } from '../../src/api/apply-command-action-client.ts';
import { changeOrderStatuses } from '../../src/routes/[lang]/prodej/objednavky/orders-records.ts';

rstest.mock('../../src/api/apply-command-action-client.ts');

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
  rstest.resetAllMocks();
});

describe('bulk order status commands', () => {
  it.effect('counts mixed outcomes and advances the next revision only after confirmed writes', () =>
    Effect.gen(function* mixedOutcomes() {
      const conflict = yield* Schema.decodeEffect(ApplyCommandActionConflictProblemSchema)({
        _tag: 'ApplyCommandActionConflictProblem',
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
      rstest
        .mocked(executeApplyCommand)
        .mockReturnValueOnce(Effect.fail(conflict))
        .mockReturnValueOnce(Effect.succeed(firstCommit))
        .mockReturnValueOnce(Effect.fail(conflict))
        .mockReturnValueOnce(Effect.succeed(secondCommit));

      const result = yield* changeOrderStatuses({
        orders: ['order-1', 'order-2', 'order-3', 'order-4'].map(order),
        revision: 10,
        status: 'CONFIRMED',
      });

      expect(result).toEqual({ changed: 2, failed: 2, revision: 27 });
      const { calls } = rstest.mocked(executeApplyCommand).mock;
      expect(calls.map(([payload]) => payload)).toEqual([
        { command: { _tag: 'ChangeOrderStatus', id: 'order-1', status: 'CONFIRMED' }, expectedRevision: 10 },
        { command: { _tag: 'ChangeOrderStatus', id: 'order-2', status: 'CONFIRMED' }, expectedRevision: 10 },
        { command: { _tag: 'ChangeOrderStatus', id: 'order-3', status: 'CONFIRMED' }, expectedRevision: 14 },
        { command: { _tag: 'ChangeOrderStatus', id: 'order-4', status: 'CONFIRMED' }, expectedRevision: 14 },
      ]);
      const keys = calls.map(({ 2: options }) => options.idempotencyKey);
      expect(keys).toHaveLength(4);
      expect(new Set(keys).size).toBe(4);
      for (const key of keys) {
        expect(key.length).toBeGreaterThan(0);
      }
    }),
  );

  it.effect('does not write or advance the revision for an empty selection', () =>
    Effect.gen(function* emptySelection() {
      const result = yield* changeOrderStatuses({ orders: [], revision: 10, status: 'CONFIRMED' });
      expect(result).toEqual({ changed: 0, failed: 0, revision: 10 });
      expect(executeApplyCommand).not.toHaveBeenCalled();
    }),
  );
});
