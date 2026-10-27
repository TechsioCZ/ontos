import { AiAdapterFailure, AiFailure } from '@app/shared-contracts/ai-approvals';
import { DateTime, Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import {
  MerchandiseCommandSchema,
  merchandiseAiCommandSchemas,
  MerchandiseNotFound,
  MerchandisePermissionDenied,
} from '../../shared/actions/apply-command.ts';
import { MerchandiseStateSchema } from '../../shared/apis/records.ts';
import type { MerchandiseState } from '../../shared/apis/records.ts';
import { assertCommandAllowed } from '../../shared/actions/command-guard.ts';
import { ProductIdSchema } from '../../shared/domain/merchandise-model.ts';
import { applyMerchandiseAiCommand } from '../../src/services/ai-changes.ts';
import {
  describeAddress,
  describeContact,
  describeLines,
  describeShipping,
  evolveMerchandiseState,
  orderStatusLabels,
} from '../../src/services/persistence.service.ts';
import { stockOnHandOf } from '../../src/services/stock-levels.ts';

/** A real asynchronous boundary with no timing assertion or external I/O. */
const nextMicrotask = Effect.promise(() => Promise.resolve());

const agent = { principalId: '20000000-0000-4000-8000-0000000000c1', tenantId: '20000000-0000-4000-8000-000000000001' };
const approver = {
  principalId: '20000000-0000-4000-8000-000000000002',
  tenantId: '20000000-0000-4000-8000-000000000001',
};
const now = DateTime.makeUnsafe('2026-10-21T08:00:00Z');
const AiCommandSchema = Schema.Union(merchandiseAiCommandSchemas);
type CommandInput = typeof MerchandiseCommandSchema.Encoded;
type AiCommandInput = typeof AiCommandSchema.Encoded;
const decode = Schema.decodeUnknownSync(MerchandiseCommandSchema);
const roundTrip = (state: MerchandiseState) =>
  Schema.decodeUnknownSync(MerchandiseStateSchema)(Schema.encodeSync(MerchandiseStateSchema)(state));
const stock = (state: MerchandiseState) =>
  stockOnHandOf(state.movements, Schema.decodeUnknownSync(ProductIdSchema)('product-1'));

const run = (state: MerchandiseState, input: CommandInput, resourceId: string) =>
  evolveMerchandiseState(state, decode(input), { actor: approver, now, resourceId }).pipe(
    Effect.map((change) => roundTrip(change.state)),
  );
const ai = (state: MerchandiseState, input: AiCommandInput, invocationId: string, actor = approver) =>
  applyMerchandiseAiCommand(
    state,
    Schema.decodeUnknownSync(AiCommandSchema)(input),
    { actor, invocationId, now },
    { describeAddress, describeContact, describeLines, describeShipping, evolveMerchandiseState, orderStatusLabels },
  ).pipe(Effect.map((outcome) => ({ ...outcome, state: roundTrip(outcome.state) })));

const seeded = Effect.gen(function* seed() {
  const product = yield* run(
    { movements: [], orders: [], products: [] },
    {
      _tag: 'CreateProduct',
      active: true,
      category: 'IT',
      lowStockThreshold: 2,
      name: 'Switch 24 portů',
      priceMinor: 450_000,
      sku: 'SW-24',
      unit: 'ks',
      vatRate: 21,
    },
    'product-1',
  );
  const received = yield* run(
    product,
    { _tag: 'RecordStockMovement', delta: 10, productId: 'product-1', reason: 'RECEIPT' },
    'receipt-1',
  );
  return yield* run(
    received,
    { _tag: 'CreateOrder', id: 'order-1', lines: [{ productId: 'product-1', quantity: 3 }], partyId: 'party-1' },
    'order-1',
  );
});

it.effect('an approved order cancellation returns stock; Vrátit vše restores the order and re-books the stock', () =>
  Effect.gen(function* flow() {
    const start = yield* seeded;
    expect(stock(start)).toBe(7);
    const proposed = yield* ai(
      start,
      {
        _tag: 'AiProposeChanges',
        changes: [
          {
            operation: { _tag: 'ChangeOrderStatus', id: 'order-1', status: 'CANCELLED' },
            reason: 'Zákazník objednávku zrušil e-mailem.',
          },
        ],
        instruction: 'Stornuj objednávku zákazníka.',
        runId: 'run-1',
      },
      '80000000-0000-4000-8000-000000000001',
      agent,
    );
    expect(proposed.state.orders[0]?.status).toBe('NEW');
    expect(stock(proposed.state)).toBe(7);
    expect(proposed.state.aiChanges?.changes[0]?.diff[0]).toEqual({
      after: 'Stornovaná',
      before: 'Nová',
      field: 'status',
      label: 'Stav',
    });
    const approved = yield* ai(
      proposed.state,
      { _tag: 'AiDecideChanges', changeIds: [proposed.entityIds[1]], decision: 'approve' },
      '80000000-0000-4000-8000-000000000002',
    );
    expect(approved.state.orders[0]?.status).toBe('CANCELLED');
    expect(stock(approved.state)).toBe(10);
    const reverted = yield* ai(
      approved.state,
      { _tag: 'AiRevertBatch', batchId: proposed.entityIds[0] },
      '80000000-0000-4000-8000-000000000003',
    );
    expect(reverted.state.orders[0]?.status).toBe('NEW');
    expect(stock(reverted.state)).toBe(7);
    // The ledger keeps both the return and its compensation; the order history keeps the step and the revert.
    expect(reverted.state.movements).toHaveLength(approved.state.movements.length + 1);
    expect(reverted.state.orders[0]?.history?.map((entry) => entry.kind)).toEqual(['CREATED', 'STATUS', 'STATUS']);
  }),
);

it.effect('an approved note edit is reverted; a change made by a person since blocks the revert', () =>
  Effect.gen(function* edit() {
    const start = yield* seeded;
    const proposed = yield* ai(
      start,
      {
        _tag: 'AiProposeChanges',
        changes: [
          { operation: { _tag: 'EditOrder', id: 'order-1', note: 'Doručit po 14:00' }, reason: 'Zákazník volal.' },
        ],
        instruction: 'Doplň poznámku k objednávce.',
      },
      '80000000-0000-4000-8000-000000000011',
      agent,
    );
    const approved = yield* ai(
      proposed.state,
      { _tag: 'AiDecideChanges', changeIds: [proposed.entityIds[1]], decision: 'approve' },
      '80000000-0000-4000-8000-000000000012',
    );
    expect(approved.state.orders[0]?.note).toBe('Doručit po 14:00');
    const edited = yield* run(approved.state, { _tag: 'EditOrder', id: 'order-1', note: 'Volat předem' }, 'edit-1');
    const blocked = yield* ai(
      edited,
      { _tag: 'AiRevertBatch', batchId: proposed.entityIds[0] },
      '80000000-0000-4000-8000-000000000013',
    ).pipe(Effect.flip);
    expect(blocked.kind).toBe('conflict');
    const reverted = yield* ai(
      approved.state,
      { _tag: 'AiRevertBatch', batchId: proposed.entityIds[0] },
      '80000000-0000-4000-8000-000000000014',
    );
    expect(reverted.state.orders[0]?.note).toBeUndefined();
  }),
);

it.effect('API keys may propose but never decide or revert', () =>
  Effect.gen(function* guard() {
    yield* assertCommandAllowed('non_human', 'AiProposeChanges');
    for (const tag of ['AiDecideChanges', 'AiRevertBatch']) {
      const denied = yield* assertCommandAllowed('non_human', tag).pipe(Effect.flip);
      expect(Schema.is(MerchandisePermissionDenied)(denied)).toBe(true);
    }
  }),
);

it.live('order description awaits the owner reducer without starting a nested runtime', () =>
  Effect.gen(function* asynchronousDescription() {
    const start = yield* seeded;
    const proposed = yield* applyMerchandiseAiCommand(
      start,
      Schema.decodeUnknownSync(AiCommandSchema)({
        _tag: 'AiProposeChanges',
        changes: [
          {
            operation: { _tag: 'ChangeOrderStatus', id: 'order-1', status: 'CANCELLED' },
            reason: 'Zákazník objednávku zrušil.',
          },
        ],
        instruction: 'Stornuj objednávku zákazníka.',
      }),
      { actor: agent, invocationId: 'async-order-description', now },
      {
        describeAddress,
        describeContact,
        describeLines,
        describeShipping,
        evolveMerchandiseState: (state, command, input) =>
          evolveMerchandiseState(state, command, input).pipe(Effect.tap(() => nextMicrotask)),
        orderStatusLabels,
      },
    );
    expect(proposed.state.orders).toBe(start.orders);
    expect(stock(proposed.state)).toBe(7);
    expect(proposed.state.aiChanges?.changes[0]?.diff[0]).toEqual({
      after: 'Stornovaná',
      before: 'Nová',
      field: 'status',
      label: 'Stav',
    });
    expect(proposed.state.aiChanges?.changes[0]?.proposedSnapshots?.map((snapshot) => snapshot.kind)).toEqual([
      'order',
      'movement',
    ]);
  }),
);

it.effect('order proposal rejection preserves its Czech message and original typed reducer failure', () =>
  Effect.gen(function* failedOrderProposal() {
    const start = yield* seeded;
    const failure = yield* ai(
      start,
      {
        _tag: 'AiProposeChanges',
        changes: [
          {
            operation: { _tag: 'EditOrder', id: 'missing-order', note: 'Doručit po 14:00' },
            reason: 'Zákazník volal.',
          },
        ],
        instruction: 'Doplň poznámku k objednávce.',
      },
      'missing-order-proposal',
      agent,
    ).pipe(Effect.flip);
    expect(Schema.is(AiFailure)(failure)).toBe(true);
    expect(failure.kind).toBe('invalid');
    expect(failure.message).toBe('Návrh č. 1 (Úprava objednávky) nelze přijmout: Objednávka neexistuje.');
    expect(Schema.is(AiAdapterFailure)(failure.cause)).toBe(true);
    expect(Schema.is(MerchandiseNotFound)(failure.cause?.cause)).toBe(true);
    expect(start.aiChanges).toBeUndefined();
    expect(stock(start)).toBe(7);
  }),
);
