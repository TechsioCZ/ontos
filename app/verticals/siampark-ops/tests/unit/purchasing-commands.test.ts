import { DateTime, Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { PrincipalRefSchema } from '@app/core-runtime/permissions/principal-ref';
import { buildPurchasingSeed } from '../../scripts/seed/purchasing.mts';
import { PurchasingCommandSchema, evolvePurchasing } from '../../shared/commands/purchasing.ts';
import { SiamparkOpsLifecycleConflict } from '../../shared/errors/siampark-ops-lifecycle-conflict.ts';
import { PurchasingStateSchema, StockItemIdSchema, emptyPurchasingState } from '../../shared/domain/purchasing.ts';
import type { PurchasingState } from '../../shared/domain/purchasing.ts';
import { materialPlanOf, onHandOf, serialsInStock, stockLevelOf } from '../../shared/domain/purchasing-stock.ts';

const actor = Schema.decodeUnknownSync(PrincipalRefSchema)({
  principalId: '72000000-0000-4000-8000-000000000022',
  tenantId: '70000000-0000-4000-8000-000000000020',
});
const t0 = DateTime.makeUnsafe('2026-10-20T08:00:00Z');
const empty = Schema.decodeUnknownSync(PurchasingStateSchema)(emptyPurchasingState);
const decodeCommand = Schema.decodeUnknownSync(PurchasingCommandSchema);
const isConflict = Schema.is(SiamparkOpsLifecycleConflict);
const itemId = (value: string) => Schema.decodeUnknownSync(StockItemIdSchema)(value);

type CommandInput = typeof PurchasingCommandSchema.Encoded;
const apply = (state: PurchasingState, command: CommandInput, resourceId: string) =>
  evolvePurchasing(state, decodeCommand(command), { actor, now: t0, resourceId });

/** Warehouse + supplier + one item with the given tracking and minimum 8. */
const base = (tracking: 'none' | 'batch' | 'serial' = 'none') =>
  Effect.gen(function* setup() {
    const warehouse = yield* apply(empty, { _tag: 'StockWarehouseCreate', code: 'SKL', name: 'Sklad' }, 'wh');
    const other = yield* apply(warehouse.state, { _tag: 'StockWarehouseCreate', code: 'SKL2', name: 'Dílna' }, 'wh2');
    const supplier = yield* apply(other.state, { _tag: 'PurchaseSupplierCreate', name: 'Dodavatel s.r.o.' }, 'sup');
    const item = yield* apply(
      supplier.state,
      {
        _tag: 'StockItemCreate',
        category: 'spare_part',
        leadTimeDays: 10,
        maximum: 20,
        minimum: 8,
        name: 'Detektor',
        sku: 'ND-1',
        supplierId: 'sup',
        tracking,
        unit: 'ks',
        warehouseId: 'wh',
      },
      'item',
    );
    return item.state;
  });

const receipt = (
  state: PurchasingState,
  quantity: number,
  resourceId: string,
  extra: Partial<Record<string, unknown>> = {},
) =>
  apply(
    state,
    { _tag: 'StockReceipt', date: '2026-10-20', itemId: 'item', quantity, reason: 'Příjem', ...extra } as CommandInput,
    resourceId,
  );

it.effect('S05-01: issuing 3 of 10 leaves 7 and keeps a ledger row with the author', () =>
  Effect.gen(function* s0501() {
    const stocked = yield* receipt(yield* base(), 10, 'r1');
    const issued = yield* apply(
      stocked.state,
      {
        _tag: 'StockIssue',
        date: '2026-10-20',
        itemId: 'item',
        quantity: 3,
        reason: 'Oprava',
        refs: [{ id: 't1', kind: 'task', label: 'Úkol' }],
      },
      'i1',
    );
    expect(onHandOf(issued.state, itemId('item'))).toBe(7);
    const row = issued.state.movements.at(-1);
    expect(row?.kind).toBe('issue');
    expect(row?.quantity).toBe(-3);
    expect(row?.createdBy).toEqual(actor);
    expect(row?.refs[0]?.kind).toBe('task');
  }),
);

it.effect('S05-02: stock 7 with minimum 8 is below minimum, 8 is not', () =>
  Effect.gen(function* s0502() {
    const stocked = yield* receipt(yield* base(), 7, 'r1');
    const item = stocked.state.items[0];
    expect(item === undefined ? undefined : stockLevelOf(item, onHandOf(stocked.state, item.id))).toBe('below_minimum');
    expect(item === undefined ? undefined : stockLevelOf(item, 8)).toBe('ok');
    expect(item === undefined ? undefined : stockLevelOf(item, 21)).toBe('above_maximum');
  }),
);

it.effect('S05-03: issuing 20 of 7 is refused and the state is unchanged', () =>
  Effect.gen(function* s0503() {
    const stocked = yield* receipt(yield* base(), 7, 'r1');
    const error = yield* apply(
      stocked.state,
      { _tag: 'StockIssue', date: '2026-10-20', itemId: 'item', quantity: 20, reason: 'Výdej' },
      'i1',
    ).pipe(Effect.flip);
    expect(isConflict(error)).toBe(true);
    expect(onHandOf(stocked.state, itemId('item'))).toBe(7);
  }),
);

it.effect('S05-04: serial numbers are required per unit and traceable to their movements', () =>
  Effect.gen(function* s0504() {
    const start = yield* base('serial');
    const missing = yield* receipt(start, 2, 'r0', { serialNumbers: ['A1'] }).pipe(Effect.flip);
    expect(isConflict(missing)).toBe(true);
    const stocked = yield* receipt(start, 2, 'r1', { serialNumbers: ['A1', 'A2'] });
    const issued = yield* apply(
      stocked.state,
      { _tag: 'StockIssue', date: '2026-10-20', itemId: 'item', quantity: 1, reason: 'Montáž', serialNumbers: ['A2'] },
      'i1',
    );
    const wrong = yield* apply(
      issued.state,
      { _tag: 'StockIssue', date: '2026-10-20', itemId: 'item', quantity: 1, reason: 'Montáž', serialNumbers: ['A2'] },
      'i2',
    ).pipe(Effect.flip);
    expect(isConflict(wrong)).toBe(true);
    expect([...serialsInStock(issued.state, itemId('item')).keys()]).toEqual(['A1']);
    const trail = issued.state.movements.filter((row) => row.serialNumbers?.includes('A2'));
    expect(trail.map((row) => row.kind)).toEqual(['receipt', 'issue']);
  }),
);

it.effect('A correction needs a non-zero delta and cannot make stock negative; transfer keeps the total', () =>
  Effect.gen(function* corrections() {
    const stocked = yield* receipt(yield* base(), 5, 'r1');
    const zero = yield* apply(
      stocked.state,
      { _tag: 'StockAdjustment', date: '2026-10-20', delta: 0, itemId: 'item', reason: 'x' },
      'a0',
    ).pipe(Effect.flip);
    expect(isConflict(zero)).toBe(true);
    const below = yield* apply(
      stocked.state,
      { _tag: 'StockAdjustment', date: '2026-10-20', delta: -6, itemId: 'item', reason: 'Inventura' },
      'a1',
    ).pipe(Effect.flip);
    expect(isConflict(below)).toBe(true);
    const moved = yield* apply(
      stocked.state,
      {
        _tag: 'StockTransfer',
        date: '2026-10-20',
        fromWarehouseId: 'wh',
        itemId: 'item',
        quantity: 2,
        reason: 'Do dílny',
        toWarehouseId: 'wh2',
      },
      't1',
    );
    expect(onHandOf(moved.state, itemId('item'))).toBe(5);
  }),
);

it.effect('S06-01/02: order from a quote keeps line and price; 1 of 2 delivered is partial with 1 remaining', () =>
  Effect.gen(function* s0601() {
    const start = yield* base();
    const quote = yield* apply(
      start,
      {
        _tag: 'PurchaseQuoteCreate',
        currency: 'CZK',
        date: '2026-10-20',
        lines: [{ description: 'Detektor', itemId: 'item', quantity: 2, unitPriceMinor: 129_000 }],
        number: 'N-1',
        supplierId: 'sup',
      },
      'q1',
    );
    const ordered = yield* apply(
      quote.state,
      { _tag: 'PurchaseOrderCreateFromQuote', quoteId: 'q1', warehouseId: 'wh' },
      'po',
    );
    const order = ordered.state.orders[0];
    expect(order?.quoteId).toBe('q1');
    expect(order?.lines[0]?.quantity).toBe(2);
    expect(order?.lines[0]?.unitPriceMinor).toBe(129_000);
    expect(order?.status).toBe('draft');
    expect(ordered.state.quotes[0]?.status).toBe('accepted');
    const again = yield* apply(
      ordered.state,
      { _tag: 'PurchaseOrderCreateFromQuote', quoteId: 'q1', warehouseId: 'wh' },
      'po2',
    ).pipe(Effect.flip);
    expect(isConflict(again)).toBe(true);
    const early = yield* apply(
      ordered.state,
      {
        _tag: 'PurchaseOrderReceive',
        date: '2026-10-20',
        lines: [{ lineId: 'po:line-1', quantity: 1 }],
        orderId: 'po',
      },
      'd0',
    ).pipe(Effect.flip);
    expect(isConflict(early)).toBe(true);
    const approved = yield* apply(
      ordered.state,
      { _tag: 'PurchaseOrderTransition', orderId: 'po', to: 'approved' },
      'x1',
    );
    const sent = yield* apply(approved.state, { _tag: 'PurchaseOrderTransition', orderId: 'po', to: 'ordered' }, 'x2');
    const partial = yield* apply(
      sent.state,
      {
        _tag: 'PurchaseOrderReceive',
        date: '2026-10-21',
        lines: [{ lineId: 'po:line-1', quantity: 1 }],
        orderId: 'po',
      },
      'd1',
    );
    const after = partial.state.orders[0];
    expect(after?.status).toBe('partially_delivered');
    expect((after?.lines[0]?.quantity ?? 0) - (after?.lines[0]?.receivedQuantity ?? 0)).toBe(1);
    expect(onHandOf(partial.state, itemId('item'))).toBe(1);
    expect(partial.state.movements.at(-1)?.purchaseOrderId).toBe('po');
    const over = yield* apply(
      partial.state,
      {
        _tag: 'PurchaseOrderReceive',
        date: '2026-10-21',
        lines: [{ lineId: 'po:line-1', quantity: 2 }],
        orderId: 'po',
      },
      'd2',
    ).pipe(Effect.flip);
    expect(isConflict(over)).toBe(true);
    const done = yield* apply(
      partial.state,
      {
        _tag: 'PurchaseOrderReceive',
        date: '2026-10-22',
        lines: [{ lineId: 'po:line-1', quantity: 1 }],
        orderId: 'po',
      },
      'd3',
    );
    expect(done.state.orders[0]?.status).toBe('completed');
    expect(done.state.orders[0]?.history.map((entry) => entry.event)).toEqual([
      'created',
      'approved',
      'ordered',
      'delivery',
      'delivery',
      'completed',
    ]);
    const linked = yield* apply(done.state, { _tag: 'PurchaseOrderLinkInvoice', number: 'FA-1', orderId: 'po' }, 'inv');
    expect(linked.state.orders[0]?.invoices[0]?.number).toBe('FA-1');
    const cancel = yield* apply(
      done.state,
      { _tag: 'PurchaseOrderTransition', orderId: 'po', to: 'cancelled' },
      'c1',
    ).pipe(Effect.flip);
    expect(isConflict(cancel)).toBe(true);
  }),
);

it.effect('Material plan counts open orders and planned issues and suggests replenishment up to the maximum', () =>
  Effect.gen(function* plan() {
    const stocked = yield* receipt(yield* base(), 5, 'r1');
    const planned = yield* apply(
      stocked.state,
      { _tag: 'StockPlannedIssueCreate', date: '2026-11-01', itemId: 'item', quantity: 4, reason: 'Revize' },
      'p1',
    );
    const item = planned.state.items[0];
    if (item === undefined) {
      return;
    }
    const result = materialPlanOf(planned.state, item, '2026-10-20');
    expect(result.projected).toBe(1);
    expect(result.suggestedQuantity).toBe(19);
  }),
);

it('The demo seed replays through the reducer (21 items, 4 orders, BZ-001 at 7 below minimum 8)', () => {
  const seed = buildPurchasingSeed();
  expect(seed.items).toHaveLength(21);
  expect(seed.orders.map((order) => order.status)).toEqual(['partially_delivered', 'completed', 'ordered', 'draft']);
  const chlorine = seed.items.find((entry) => entry.sku === 'BZ-001');
  expect(chlorine === undefined ? undefined : onHandOf(seed, chlorine.id)).toBe(7);
});
