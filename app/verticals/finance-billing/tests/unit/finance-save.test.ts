import { DateTime, Option, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';
import { PriceListItemSchema } from '../../shared/apis/records.ts';
import type { Invoice } from '../../shared/apis/records.ts';
import { FinanceCommandSchema } from '../../shared/actions/apply-command.ts';
import {
  paymentTermsCommandOf,
  paymentTermsDraftOf,
  paymentTermsUnchangedSince,
  samePaymentTermsDraft,
} from '../../src/routes/[lang]/finance/payment-terms-draft.ts';
import {
  financeSaveOutcome,
  itemCommandOf,
  itemDraftOf,
  itemUnchangedSince,
  sameItemDraft,
} from '../../src/routes/[lang]/finance/price-list-draft.ts';

const item = Schema.decodeUnknownSync(PriceListItemSchema)({
  active: true,
  code: 'NAJ-01',
  id: 'price-office-rent',
  name: 'Nájem kanceláře',
  unit: 'měsíc',
  unitPriceMinor: 1_850_050,
  updatedAt: '2026-10-05T08:00:00.000Z',
  vatClassification: 'cz.vat.standard',
  vatRate: 21,
});
const saved = itemDraftOf(item);

describe('price list item draft', () => {
  it('shows the price in crowns and ignores surrounding spaces', () => {
    expect(saved.price).toBe('18500,50');
    expect(sameItemDraft(saved, { ...saved, name: ' Nájem kanceláře ' })).toBe(true);
    expect(sameItemDraft(saved, { ...saved, vat: { code: 'cz.vat.reduced', kind: 'classification' } })).toBe(false);
  });

  it('keeps the id and offer state of an edited item and never saves without a name or price', () => {
    const command = Option.getOrThrow(itemCommandOf({ ...saved, price: '19 000' }, undefined, item, 'Jana Nováková'));
    expect(command).toMatchObject({ active: true, id: item.id, unitPriceMinor: 1_900_000 });
    expect(Option.isNone(itemCommandOf({ ...saved, name: ' ' }, undefined, item))).toBe(true);
    expect(Option.isNone(itemCommandOf({ ...saved, price: 'zdarma' }, undefined, item))).toBe(true);
  });

  it('saves only while the price list still holds the version the draft builds on', () => {
    expect(itemUnchangedSince(item.id, saved)([item])).toBe(true);
    expect(itemUnchangedSince(item.id, saved)([{ ...item, unitPriceMinor: 1 }])).toBe(false);
    expect(itemUnchangedSince(item.id, saved)([])).toBe(false);
  });

  it('maps a command outcome onto a save outcome', () => {
    expect(financeSaveOutcome({ ok: true })).toBe('saved');
    expect(financeSaveOutcome({ feedback: 'conflict', ok: false })).toBe('conflict');
    expect(financeSaveOutcome({ feedback: 'forbidden', ok: false })).toBe('failed');
    // A change parked for approval saved nothing, and it did not fail either.
    expect(financeSaveOutcome({ feedback: 'pendingApproval', ok: false })).toBe('proposed');
  });
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
    expect(
      Option.getOrThrow(
        paymentTermsCommandOf(invoice, { ...terms, lateAmount: '120,50', lateText: ' 0,05 % denně ' }, 'Jana Nováková'),
      ),
    ).toEqual(
      FinanceCommandSchema.pipe(Schema.toTaggedUnion('_tag')).cases.SetPaymentTerms.make({
        actorLabel: 'Jana Nováková',
        invoiceRef: invoice.ref,
        lateInterestApprovedMinor: 12_050,
        lateInterestText: '0,05 % denně',
        skontoApprovedMinor: 50_000,
        skontoText: '2 % při úhradě do 7 dnů',
      }),
    );
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
