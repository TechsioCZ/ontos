import { draftSavable, startDraftSave } from '@app/admin-ui';
import type { SaveOutcome } from '@app/admin-ui';
import { Effect, Option, Schema } from 'effect';
import { TestClock } from 'effect/testing';
import { describe, expect, it } from 'effect-rstest';
import { SalesQuoteSchema } from '../../shared/domain/purchasing.ts';
import {
  quoteDraftOf,
  quoteUpdateCommandOf,
  sameQuoteDraft,
} from '../../src/routes/[lang]/provoz/nakupy/sales-quote-draft.ts';
import type { QuoteDraft } from '../../src/routes/[lang]/provoz/nakupy/sales-quote-draft.ts';

const tenantId = '70000000-0000-4000-8000-000000000020';
const actor = { principalId: '72000000-0000-4000-8000-000000000021', tenantId };
const at = '2026-10-20T08:00:00Z';
const quote = Schema.decodeUnknownSync(SalesQuoteSchema)({
  createdAt: at,
  createdBy: actor,
  currency: 'CZK',
  customer: { counterpartyId: '44444444-4444-4444-8444-444444444444', name: 'Kavárna Dolce', tenantId },
  date: '2026-10-20',
  id: 'quote-1',
  lines: [
    {
      description: 'Servis vzduchotechniky',
      id: 'line-1',
      quantity: 1,
      unitPriceMinor: 1_500_000,
      vatRate: 21,
    },
  ],
  note: 'Servis do konce měsíce',
  number: 'NAB-2026-014',
  status: 'draft',
  updatedAt: at,
  updatedBy: actor,
  validUntil: '2026-11-19',
});
const customer = { counterpartyId: quote.customer.counterpartyId, name: quote.customer.name, tenantId };
const stored = quoteDraftOf(quote);
/** The single stored line, for the cases that edit it. */
const line = stored.lines[0] ?? { description: '', price: '', quantity: '1', vat: 21 as const };

describe('quote edit draft', () => {
  it('starts from the stored quote and compares without surrounding spaces or row keys', () => {
    expect(stored.customerId).toBe(quote.customer.counterpartyId);
    expect(line.price).toBe('15000');
    expect(sameQuoteDraft(stored, { ...stored, note: ' Servis do konce měsíce ' })).toBe(true);
    expect(sameQuoteDraft(stored, { ...stored, validUntil: '2026-11-30' })).toBe(false);
    expect(sameQuoteDraft(stored, { ...stored, lines: [{ ...line, quantity: '2' }] })).toBe(false);
  });

  it('never saves a quote without a resolvable customer, a date or a complete line', () => {
    expect(Option.isNone(quoteUpdateCommandOf(stored, quote))).toBe(true);
    expect(Option.isNone(quoteUpdateCommandOf({ ...stored, date: '' }, quote, customer))).toBe(true);
    expect(Option.isNone(quoteUpdateCommandOf({ ...stored, validUntil: '2026-10-01' }, quote, customer))).toBe(true);
    const brokenLine = [{ ...line, price: 'zdarma' }];
    expect(Option.isNone(quoteUpdateCommandOf({ ...stored, lines: brokenLine }, quote, customer))).toBe(true);
  });

  it('sends the trimmed note and keeps the quote in its own lifecycle state', () => {
    const command = Option.getOrThrow(
      quoteUpdateCommandOf({ ...stored, note: '  Servis prodloužen  ' }, quote, customer),
    );
    expect(command).toMatchObject({ note: 'Servis prodloužen', quoteId: quote.id });
    expect('status' in command).toBe(false);
  });
});

const panel = Effect.fnUntraced(function* panel(outcome: SaveOutcome) {
  const sent: QuoteDraft[] = [];
  const controller = yield* startDraftSave(stored, {
    equals: sameQuoteDraft,
    isValid: (value: QuoteDraft) => Option.isSome(quoteUpdateCommandOf(value, quote, customer)),
    save: (value: QuoteDraft) => Effect.sync(() => sent.push(value)).pipe(Effect.as(outcome)),
  });
  return { controller, sent };
});

describe('quote edit explicit save', () => {
  it.effect('sends a typed note only on Save, once; an unfinished line stays local', () =>
    Effect.gen(function* typed() {
      const { controller, sent } = yield* panel('saved');
      controller.change({ ...stored, lines: [{ ...line, price: '' }] });
      controller.save();
      expect(controller.status()).toBe('invalid');
      expect(draftSavable(controller.status())).toBe(false);
      controller.change({ ...stored, note: 'Servis prodloužen' });
      // Longer than any delay the panel ever saved after: typing alone sends nothing.
      yield* TestClock.adjust('1 minute');
      expect(sent).toEqual([]);
      expect(controller.status()).toBe('dirty');
      controller.save();
      controller.save();
      yield* Effect.yieldNow;
      expect(sent.map(({ note }) => note)).toEqual(['Servis prodloužen']);
      expect(controller.status()).toBe('saved');
    }),
  );

  it.effect('discard goes back to the confirmed draft and sends nothing', () =>
    Effect.gen(function* discarded() {
      const { controller, sent } = yield* panel('saved');
      controller.change({ ...stored, note: 'Servis prodloužen' });
      expect(controller.status()).toBe('dirty');
      controller.discard();
      expect(controller.status()).toBe('idle');
      expect(controller.confirmed()).toBe(stored);
      yield* TestClock.adjust('1 minute');
      expect(sent).toEqual([]);
    }),
  );

  it.effect('holds a conflicting draft instead of sending it again', () =>
    Effect.gen(function* conflict() {
      const { controller, sent } = yield* panel('conflict');
      controller.change({ ...stored, note: 'První pokus' });
      controller.save();
      yield* Effect.yieldNow;
      expect(controller.status()).toBe('conflict');
      controller.change({ ...stored, note: 'Druhý pokus' });
      yield* TestClock.adjust('1 second');
      expect(sent).toHaveLength(1);
    }),
  );
});
