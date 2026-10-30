import { DateTime, Effect, Exit, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { PrincipalRefSchema } from '@app/core-runtime/permissions/principal-ref';
import { PurchasingCommandSchema, evolvePurchasing } from '../../shared/commands/purchasing.ts';
import { salesRemainder } from '../../shared/commands/sales.ts';
import { PurchasingStateSchema, emptyPurchasingState } from '../../shared/domain/purchasing.ts';
import type { PurchasingState } from '../../shared/domain/purchasing.ts';

const actor = Schema.decodeUnknownSync(PrincipalRefSchema)({
  principalId: '72000000-0000-4000-8000-000000000021',
  tenantId: '70000000-0000-4000-8000-000000000020',
});
const now = DateTime.makeUnsafe('2026-10-21T08:00:00Z');
const empty = Schema.decodeUnknownSync(PurchasingStateSchema)(emptyPurchasingState);
const decode = Schema.decodeUnknownSync(PurchasingCommandSchema);
const apply = (state: PurchasingState, command: typeof PurchasingCommandSchema.Encoded, resourceId: string) =>
  evolvePurchasing(state, decode(command), { actor, now, resourceId });
const customer = { counterpartyId: 'cp-1', name: 'Kavárna U Parku s.r.o.', partyId: 'p-1', tenantId: 't-1' };

it.effect('S06-01/02: quote → sales order keeps line, price and quote link; 1 of 2 delivered leaves 1 open', () =>
  Effect.gen(function* s0601() {
    const quoted = yield* apply(
      empty,
      {
        _tag: 'SalesQuoteCreate',
        customer,
        date: '2026-10-21',
        lines: [{ description: 'Pronájem salonku', quantity: 2, unitPriceMinor: 450_000, vatRate: 21 }],
        status: 'sent',
      },
      'q1',
    );
    const [quote] = quoted.state.salesQuotes ?? [];
    if (quote === undefined) {
      throw new Error('Missing created sales quote');
    }
    const [quoteLine] = quote.lines;
    if (quoteLine === undefined) {
      throw new Error('Missing created sales quote line');
    }
    expect(quote.number).toBe('NAB-SP-2026-0001');
    const ordered = yield* apply(quoted.state, { _tag: 'SalesOrderCreateFromQuote', quoteId: 'q1' }, 'o1');
    const [order] = ordered.state.salesOrders ?? [];
    if (order === undefined) {
      throw new Error('Missing created sales order');
    }
    const [orderLine] = order.lines;
    if (orderLine === undefined) {
      throw new Error('Missing created sales order line');
    }
    expect(order.number).toBe('PRO-2026-0001');
    expect(order.quoteId).toBe('q1');
    expect(orderLine.unitPriceMinor).toBe(450_000);
    expect(orderLine.quoteLineId).toBe(quoteLine.id);
    expect(ordered.state.salesQuotes?.[0]?.status).toBe('accepted');
    const approved = yield* apply(ordered.state, { _tag: 'SalesOrderTransition', orderId: 'o1', to: 'approved' }, 'a1');
    const confirmed = yield* apply(
      approved.state,
      { _tag: 'SalesOrderTransition', orderId: 'o1', to: 'ordered' },
      'c1',
    );
    const lineId = orderLine.id;
    const delivered = yield* apply(
      confirmed.state,
      { _tag: 'SalesOrderDeliver', date: '2026-10-22', lines: [{ lineId, quantity: 1 }], orderId: 'o1' },
      'd1',
    );
    const [after] = delivered.state.salesOrders ?? [];
    if (after === undefined) {
      throw new Error('Missing delivered sales order');
    }
    expect(after.status).toBe('partially_delivered');
    expect(salesRemainder(after).map((entry) => entry.remaining)).toEqual([1]);
    // Editing the quote later never changes the order (its lines are a copy).
    const edited = yield* apply(
      delivered.state,
      {
        _tag: 'SalesQuoteUpdate',
        customer,
        date: '2026-10-21',
        lines: [{ description: 'Pronájem salonku', quantity: 2, unitPriceMinor: 990_000, vatRate: 21 }],
        quoteId: 'q1',
      },
      'u1',
    );
    expect(edited.state.salesOrders?.[0]?.lines[0]?.unitPriceMinor).toBe(450_000);
    const overDelivery = yield* Effect.exit(
      apply(
        edited.state,
        { _tag: 'SalesOrderDeliver', date: '2026-10-23', lines: [{ lineId, quantity: 2 }], orderId: 'o1' },
        'd2',
      ),
    );
    expect(Exit.isFailure(overDelivery)).toBe(true);
  }),
);
