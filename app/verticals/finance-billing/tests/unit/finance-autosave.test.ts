import { startDraftSave } from '@app/admin-ui';
import type { SaveOutcome } from '@app/admin-ui';
import { DateTime, Effect, Option, Schema } from 'effect';
import { TestClock } from 'effect/testing';
import { describe, expect, it } from 'effect-rstest';
import { PriceListItemSchema } from '../../shared/apis/records.ts';
import type { Invoice } from '../../shared/apis/records.ts';
import {
  paymentTermsCommandOf,
  paymentTermsDraftOf,
  paymentTermsUnchangedSince,
  samePaymentTermsDraft,
} from '../../src/routes/[lang]/finance/payment-terms-draft.ts';
import {
  financeAutosaveOutcome,
  itemCommandOf,
  itemDraftOf,
  itemUnchangedSince,
  sameItemDraft,
} from '../../src/routes/[lang]/finance/price-list-draft.ts';
import type { ItemDraft } from '../../src/routes/[lang]/finance/price-list-draft.ts';

const item = Schema.decodeUnknownSync(PriceListItemSchema)({
  active: true,
  code: 'NAJ-01',
  id: 'price-office-rent',
  name: 'Nájem kanceláře',
  unit: 'měsíc',
  unitPriceMinor: 1_850_050,
  updatedAt: '2026-10-05T08:00:00.000Z',
  vatRate: 21,
});
const saved = itemDraftOf(item);

describe('price list item draft', () => {
  it('shows the price in crowns and ignores surrounding spaces', () => {
    expect(saved.price).toBe('18500,50');
    expect(sameItemDraft(saved, { ...saved, name: ' Nájem kanceláře ' })).toBe(true);
    expect(sameItemDraft(saved, { ...saved, vatRate: 12 })).toBe(false);
  });

  it('keeps the id and offer state of an edited item and never saves without a name or price', () => {
    const command = Option.getOrThrow(itemCommandOf({ ...saved, price: '19 000' }, item, 'Jana Nováková'));
    expect(command).toMatchObject({ active: true, id: item.id, unitPriceMinor: 1_900_000 });
    expect(Option.isNone(itemCommandOf({ ...saved, name: ' ' }, item))).toBe(true);
    expect(Option.isNone(itemCommandOf({ ...saved, price: 'zdarma' }, item))).toBe(true);
  });

  it('saves only while the price list still holds the version the draft builds on', () => {
    expect(itemUnchangedSince(item.id, saved)([item])).toBe(true);
    expect(itemUnchangedSince(item.id, saved)([{ ...item, unitPriceMinor: 1 }])).toBe(false);
    expect(itemUnchangedSince(item.id, saved)([])).toBe(false);
  });

  it('maps a command outcome onto autosave', () => {
    expect(financeAutosaveOutcome({ ok: true })).toBe('saved');
    expect(financeAutosaveOutcome({ feedback: 'conflict', ok: false })).toBe('conflict');
    expect(financeAutosaveOutcome({ feedback: 'forbidden', ok: false })).toBe('failed');
    // A change parked for approval saved nothing, and it did not fail either.
    expect(financeAutosaveOutcome({ feedback: 'pendingApproval', ok: false })).toBe('proposed');
  });
});

const panel = Effect.fnUntraced(function* panel(outcome: SaveOutcome) {
  const sent: ItemDraft[] = [];
  const controller = yield* startDraftSave(saved, {
    equals: sameItemDraft,
    isValid: (value: ItemDraft) => Option.isSome(itemCommandOf(value, item)),
    save: (value: ItemDraft) => Effect.sync(() => sent.push(value)).pipe(Effect.as(outcome)),
  });
  return { controller, sent };
});

describe('price list item edit autosave', () => {
  it.effect('saves a typed price after the quiet time; an empty name stays local', () =>
    Effect.gen(function* typed() {
      const { controller, sent } = yield* panel('saved');
      controller.change({ ...saved, name: '' });
      controller.save();
      expect(controller.status()).toBe('invalid');
      controller.change({ ...saved, price: '19 000' });
      yield* TestClock.adjust('800 millis');
      expect(sent.map(({ price }) => price)).toEqual(['19 000']);
      expect(controller.status()).toBe('saved');
    }),
  );

  it.effect('holds a conflicting draft instead of sending it again', () =>
    Effect.gen(function* conflict() {
      const { controller, sent } = yield* panel('conflict');
      controller.change({ ...saved, unit: 'rok' });
      controller.save();
      yield* Effect.yieldNow;
      expect(controller.status()).toBe('conflict');
      controller.change({ ...saved, unit: 'čtvrtletí' });
      yield* TestClock.adjust('1 second');
      expect(sent).toHaveLength(1);
    }),
  );

  it.effect('shows a price change parked for approval as proposed, not saved or failed', () =>
    Effect.gen(function* proposed() {
      const { controller, sent } = yield* panel(financeAutosaveOutcome({ feedback: 'pendingApproval', ok: false }));
      controller.change({ ...saved, price: '21 000' });
      controller.save();
      yield* Effect.yieldNow;
      expect(sent.map(({ price }) => price)).toEqual(['21 000']);
      expect(controller.status()).toBe('proposed');
    }),
  );
});

const now = DateTime.makeUnsafe('2026-10-13T08:00:00Z');
const tenantId = 'a0000000-0000-4000-8000-000000000001';
const invoice: Invoice = {
  accountingCorrelation: 'accounting-b201',
  accountingSyncState: 'NOT_SYNCED',
  businessState: 'CONFIRMED',
  counterpartyRef: {
    moduleId: 'party.registry',
    resourceId: 'a0000000-0000-4000-8000-000000000099',
    resourceType: 'party.registry.counterparty',
    tenantId,
  },
  createdAt: now,
  currency: 'CZK',
  direction: 'OUTGOING',
  documentNumber: 'B201-2026-10',
  dueDate: '2026-10-27',
  issueDate: '2026-10-13',
  paidMinor: 0,
  paymentState: 'UNPAID',
  paymentTerms: { skontoApprovedMinor: 50_000, skontoText: '2 % při úhradě do 7 dnů', updatedAt: now },
  ref: { moduleId: 'finance.billing', resourceId: 'invoice-b201', resourceType: 'finance.billing.invoice', tenantId },
  totalMinor: 1_800_000,
  updatedAt: now,
};
const terms = paymentTermsDraftOf(invoice);

describe('payment terms draft', () => {
  it('shows the stored terms and needs a condition text next to an approved amount', () => {
    expect(terms).toEqual({ lateAmount: '', lateText: '', skontoAmount: '500', skontoText: '2 % při úhradě do 7 dnů' });
    expect(Option.isSome(paymentTermsCommandOf(invoice, terms))).toBe(true);
    expect(Option.isNone(paymentTermsCommandOf(invoice, { ...terms, skontoText: ' ' }))).toBe(true);
    expect(Option.isNone(paymentTermsCommandOf(invoice, { ...terms, lateAmount: 'hodně' }))).toBe(true);
  });

  it('saves only while the ledger still holds the terms the draft builds on', () => {
    expect(paymentTermsUnchangedSince(invoice.ref.resourceId, terms)([invoice])).toBe(true);
    const { paymentTerms: _paymentTerms, ...withoutTerms } = invoice;
    expect(paymentTermsUnchangedSince(invoice.ref.resourceId, terms)([withoutTerms])).toBe(false);
    expect(samePaymentTermsDraft(terms, { ...terms, skontoText: ' 2 % při úhradě do 7 dnů ' })).toBe(true);
  });
});
