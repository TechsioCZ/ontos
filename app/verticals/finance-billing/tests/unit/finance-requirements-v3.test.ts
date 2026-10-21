import { describe, expect, it } from 'effect-rstest';
import { DateTime, Effect, Exit } from 'effect';
import type { FinanceCommand } from '../../shared/actions/apply-command.ts';
import type { FinanceState, Invoice } from '../../shared/apis/records.ts';
import {
  cashFlowMonths,
  invoiceActualMinor,
  isTestReminderRecipient,
  paymentEvents,
} from '../../shared/domain/finance-planning.ts';
import { computeInvoiceTotals, lineDiscountMinor } from '../../shared/domain/invoice-totals.ts';
import { buildPohodaDataPack } from '../../shared/domain/pohoda-xml.ts';
import { commandReferenceAudiences } from '../../shared/domain/reference-audiences.ts';
import { MANUAL_COUNTERPARTY_ID, transitionFinance } from '../../src/services/persistence.service.ts';
import type { FinanceAnchors, FinanceValidators } from '../../src/services/persistence.service.ts';

const tenantId = 'a0000000-0000-4000-8000-000000000001';
const scope = { legalEntityId: 'a0000000-0000-4000-8000-000000000002', tenantId };
const now = DateTime.makeUnsafe('2026-10-21T08:00:00Z');
const checkedAnchors: FinanceAnchors[] = [];
const validators: FinanceValidators = {
  anchors: (anchors) => Effect.sync(() => void checkedAnchors.push(anchors)),
  exportReferences: Effect.succeed({ issuerName: 'Siampark', partners: new Map() }),
  invoice: () => Effect.void,
};
const counterpartyRef = {
  moduleId: 'party.registry' as const,
  resourceId: 'a0000000-0000-4000-8000-000000000012',
  resourceType: 'party.registry.counterparty' as const,
  tenantId,
};
const propertyRef = {
  moduleId: 'property.portfolio' as const,
  resourceId: 'a0000000-0000-4000-8000-000000000031',
  resourceType: 'property.portfolio.property' as const,
  tenantId,
};
const unitRef = {
  moduleId: 'property.portfolio' as const,
  resourceId: 'a0000000-0000-4000-8000-000000000032',
  resourceType: 'property.portfolio.unit' as const,
  tenantId,
};
const invoice = (id: string, overrides: Partial<Invoice> = {}): Invoice => ({
  accountingCorrelation: `acc-${id}`,
  accountingSyncState: 'NOT_SYNCED',
  businessState: 'CONFIRMED',
  counterpartyRef,
  createdAt: now,
  currency: 'CZK',
  direction: 'OUTGOING',
  documentNumber: id,
  dueDate: '2026-10-30',
  issueDate: '2026-10-01',
  paidMinor: 0,
  paymentState: 'UNPAID',
  ref: {
    moduleId: 'finance.billing',
    resourceId: id,
    resourceType: 'finance.billing.invoice',
    tenantId,
  },
  totalMinor: 100_000,
  updatedAt: now,
  ...overrides,
});
const empty: FinanceState = {
  accountingObservations: [],
  financialPlanEntries: [],
  invoices: [],
  paymentObservations: [],
};
let counter = 0;
const run = (state: FinanceState, command: FinanceCommand) => {
  counter += 1;
  return transitionFinance(state, command, scope, validators, {
    attemptId: `attempt-${counter}`,
    now,
    principalId: 'principal-1',
    resourceId: `resource-${counter}`,
  });
};
const failsWith = (exit: Exit.Exit<unknown, unknown>, reason: string) =>
  Exit.isFailure(exit) && JSON.stringify(exit.cause).includes(reason);

describe('S07.R4 price list and discounts', () => {
  it('a percentage or fixed discount lowers the base and is kept separately with its reason', () => {
    const lines = [
      {
        description: 'Pronájem kanceláře',
        discount: { kind: 'PERCENT' as const, reason: 'Věrnostní sleva 10 %', value: 10 },
        quantity: 1,
        unitPriceMinor: 2_000_000,
        vatRate: 21 as const,
      },
      {
        description: 'Parkovací místo',
        discount: { kind: 'AMOUNT' as const, reason: 'Kompenzace za uzavírku', value: 50_000 },
        quantity: 2,
        unitPriceMinor: 150_000,
        vatRate: 21 as const,
      },
    ];
    expect(lineDiscountMinor(lines[0]!)).toBe(200_000);
    expect(lineDiscountMinor(lines[1]!)).toBe(50_000);
    expect(computeInvoiceTotals(lines)).toMatchObject({ subtotalMinor: 2_050_000, vatMinor: 430_500 });
    expect(
      computeInvoiceTotals([{ ...lines[1]!, discount: { kind: 'AMOUNT', reason: 'Příliš', value: 300_001 } }]),
    ).toBe(undefined);
  });

  it('POHODA keeps item sums equal to the recap for both discount kinds', () => {
    const lines = [
      {
        description: 'Úklid',
        discount: { kind: 'AMOUNT' as const, reason: 'Reklamace', value: 333 },
        quantity: 3,
        unitPriceMinor: 1_001,
        vatRate: 21 as const,
      },
      {
        description: 'Nájem',
        discount: { kind: 'PERCENT' as const, reason: 'Akce', value: 5 },
        quantity: 1,
        unitPriceMinor: 100_000,
        vatRate: 21 as const,
      },
    ];
    const totals = computeInvoiceTotals(lines)!;
    const xml = buildPohodaDataPack(
      [
        {
          counterpartyName: 'Nájemce',
          documentLink: 'http://localhost/x',
          invoice: invoice('pohoda', { lines, ...totals }),
        },
      ],
      { batchNumber: 'UP-2026-001', createdAt: '2026-10-21T08:00:00Z', createdBy: 'test', version: 1 },
    );
    expect(xml).toContain('<inv:discountPercentage>5</inv:discountPercentage>');
    expect(xml).toContain('Sleva: Reklamace');
    const sum = (tag: string) =>
      [...xml.matchAll(new RegExp(`<typ:${tag}>(-?[\\d.]+)</typ:${tag}>`, 'gu'))]
        .map((match) => Math.round(Number(match[1]) * 100))
        .reduce((left, right) => left + right, 0);
    expect(sum('price')).toBe(totals.subtotalMinor);
    expect(sum('priceVAT')).toBe(totals.vatMinor);
  });

  it.effect('price-list items are stored and an invalid discount is refused with a reason code', () =>
    Effect.gen(function* priceList() {
      const created = yield* run(empty, {
        _tag: 'UpsertPriceListItem',
        active: true,
        name: 'Parkovací místo – měsíc',
        unit: 'měsíc',
        unitPriceMinor: 150_000,
        vatRate: 21,
      });
      expect(created.state.priceList?.[0]).toMatchObject({ active: true, unitPriceMinor: 150_000 });
      const refused = yield* Effect.exit(
        run(empty, {
          _tag: 'CreateInvoiceDraft',
          counterpartyRef,
          currency: 'CZK',
          direction: 'OUTGOING',
          documentNumber: 'FV-2026-0001',
          dueDate: '2026-11-04',
          issueDate: '2026-10-21',
          lines: [
            {
              description: 'Nájem',
              discount: { kind: 'PERCENT', reason: 'Chyba', value: 150 },
              quantity: 1,
              unitPriceMinor: 10_000,
              vatRate: 21,
            },
          ],
        }),
      );
      expect(failsWith(refused, 'invalid_line_discount')).toBe(true);
    }),
  );
});

describe('S07.R5 lifecycle and S07.R3 bulk preparation', () => {
  it.effect('drafts move to prepared together, stay open, and approval records who approved', () =>
    Effect.gen(function* lifecycle() {
      const state = {
        ...empty,
        invoices: [
          invoice('d-1', { businessState: 'DRAFT', documentKind: 'RECURRING' }),
          invoice('d-2', { businessState: 'DRAFT', documentKind: 'RECURRING' }),
        ],
      };
      const prepared = yield* run(state, {
        _tag: 'MarkInvoicesPrepared',
        actorLabel: 'Finance Siampark',
        invoiceRefs: state.invoices.map((entry) => entry.ref),
      });
      expect(prepared.state.invoices.map((entry) => [entry.businessState, entry.reviewState])).toEqual([
        ['DRAFT', 'PREPARED'],
        ['DRAFT', 'PREPARED'],
      ]);
      expect(prepared.state.accountingExports).toBe(undefined);
      const again = yield* run(prepared.state, {
        _tag: 'MarkInvoicesPrepared',
        invoiceRefs: [state.invoices[0]!.ref],
      });
      expect(again.changed).toBe(false);
      const back = yield* run(prepared.state, { _tag: 'ReturnInvoiceToDraft', invoiceRef: state.invoices[1]!.ref });
      expect(back.invoice?.reviewState).toBe(undefined);
      const approved = yield* run(prepared.state, {
        _tag: 'ConfirmInvoice',
        actorLabel: 'Vedení',
        invoiceRef: state.invoices[0]!.ref,
      });
      expect(approved.invoice).toMatchObject({ approvedByLabel: 'Vedení', businessState: 'CONFIRMED' });
      expect(approved.invoice?.reviewState).toBe(undefined);
      const confirmedAgain = yield* Effect.exit(
        run(approved.state, { _tag: 'MarkInvoicesPrepared', invoiceRefs: [state.invoices[0]!.ref] }),
      );
      expect(failsWith(confirmedAgain, 'prepare_requires_draft')).toBe(true);
    }),
  );

  it.effect('approval of a plain draft is refused server-side with a readable Czech reason', () =>
    Effect.gen(function* plainDraft() {
      const state = { ...empty, invoices: [invoice('d-1', { businessState: 'DRAFT' })] };
      const refused = yield* Effect.exit(run(state, { _tag: 'ConfirmInvoice', invoiceRef: state.invoices[0]!.ref }));
      expect(failsWith(refused, 'confirm_requires_prepared')).toBe(true);
      expect(failsWith(refused, 'Připraveno ke schválení')).toBe(true);
      const prepared = yield* run(state, { _tag: 'MarkInvoicesPrepared', actorLabel: 'Finance', invoiceRefs: [state.invoices[0]!.ref] });
      const returned = yield* run(prepared.state, { _tag: 'ReturnInvoiceToDraft', invoiceRef: state.invoices[0]!.ref });
      const refusedAgain = yield* Effect.exit(
        run(returned.state, { _tag: 'ConfirmInvoice', invoiceRef: state.invoices[0]!.ref }),
      );
      expect(failsWith(refusedAgain, 'confirm_requires_prepared')).toBe(true);
      const approved = yield* run(prepared.state, { _tag: 'ConfirmInvoice', invoiceRef: state.invoices[0]!.ref });
      // The preparation step stays in the invoice history after approval.
      expect(approved.invoice).toMatchObject({ businessState: 'CONFIRMED', preparedByLabel: 'Finance' });
      expect(approved.invoice?.preparedAt).toBeDefined();
    }),
  );

  it('test sends to reserved test domains are recognised, customer addresses are not', () => {
    expect(isTestReminderRecipient('fakturace.audit@example.invalid')).toBe(true);
    expect(isTestReminderRecipient('fakturace@odberatel.example')).toBe(true);
    expect(isTestReminderRecipient('qa@example.com')).toBe(true);
    expect(isTestReminderRecipient('fakturace@kavarnauparku.cz')).toBe(false);
    expect(isTestReminderRecipient('ucetni@examples.cz')).toBe(false);
  });

  it.effect('S08 export goes PREPARED → HANDED_OVER → CONFIRMED, or FAILED with a reason', () =>
    Effect.gen(function* exportLifecycle() {
      const state = { ...empty, invoices: [invoice('c-1')] };
      const created = yield* run(state, {
        _tag: 'CreateAccountingExport',
        format: 'CSV',
        invoiceResourceIds: ['c-1'],
      });
      const exportId = created.state.accountingExports?.[0]?.id ?? '';
      expect(created.state.accountingExports?.[0]?.status).toBe('PREPARED');
      const early = yield* Effect.exit(
        run(created.state, { _tag: 'ConfirmAccountingExport', evidence: 'e-mail', exportId }),
      );
      expect(failsWith(early, 'export_requires_handover')).toBe(true);
      const handed = yield* run(created.state, { _tag: 'HandOverAccountingExport', actorLabel: 'Finance', exportId });
      expect(handed.state.accountingExports?.[0]).toMatchObject({ handedOverByLabel: 'Finance', status: 'HANDED_OVER' });
      const failed = yield* run(handed.state, {
        _tag: 'MarkAccountingExportFailed',
        exportId,
        reason: 'POHODA odmítla import: chybí DIČ',
      });
      expect(failed.state.accountingExports?.[0]).toMatchObject({
        failureReason: 'POHODA odmítla import: chybí DIČ',
        status: 'FAILED',
      });
      const confirmed = yield* run(handed.state, { _tag: 'ConfirmAccountingExport', evidence: 'e-mail', exportId });
      expect(confirmed.state.accountingExports?.[0]?.status).toBe('CONFIRMED_BY_ACCOUNTANT');
    }),
  );
});

describe('S07.R2 final invoice takes earlier advances into account by hand', () => {
  const advance = invoice('adv-1', { documentKind: 'ADVANCE', paidMinor: 30_000, paymentState: 'PARTIALLY_PAID' });
  const final = invoice('fin-1', { businessState: 'DRAFT', documentKind: 'FINAL', totalMinor: 100_000 });

  it.effect('links, caps by the paid amount and settles that part on approval without moving money', () =>
    Effect.gen(function* settlement() {
      const state = { ...empty, invoices: [advance, final] };
      const tooMuch = yield* Effect.exit(
        run(state, {
          _tag: 'SetPriorSettlement',
          entries: [{ amountMinor: 30_001, invoiceResourceId: 'adv-1' }],
          invoiceRef: final.ref,
        }),
      );
      expect(failsWith(tooMuch, 'prior_settlement_exceeds_paid_amount')).toBe(true);
      const set = yield* run(state, {
        _tag: 'SetPriorSettlement',
        actorLabel: 'Účetní',
        entries: [{ amountMinor: 30_000, invoiceResourceId: 'adv-1' }],
        invoiceRef: final.ref,
      });
      expect(set.invoice?.priorSettlement).toMatchObject({
        confirmedByLabel: 'Účetní',
        entries: [{ amountMinor: 30_000, invoiceResourceId: 'adv-1', number: 'adv-1' }],
      });
      const ready = yield* run(set.state, { _tag: 'MarkInvoicesPrepared', invoiceRefs: [final.ref] });
      const approved = yield* run(ready.state, { _tag: 'ConfirmInvoice', invoiceRef: final.ref });
      expect(approved.invoice).toMatchObject({ paidMinor: 30_000, paymentState: 'PARTIALLY_PAID' });
      const events = paymentEvents(approved.state).filter((event) => event.invoiceResourceId === 'fin-1');
      expect(events.map((event) => event.source)).toEqual(['PRIOR']);
      const months = cashFlowMonths(approved.state, { businessDate: '2026-10-21', fromMonth: '2026-10', months: 2 });
      // Only the advance's own payment is cash; the deduction on the final invoice moves no money.
      expect(months[0]?.paidInMinor).toBe(30_000);
      expect(months[0]?.expectedInMinor).toBe(140_000);
      const second = invoice('fin-2', { businessState: 'DRAFT', documentKind: 'FINAL' });
      const twice = yield* Effect.exit(
        run(
          { ...approved.state, invoices: [...approved.state.invoices, second] },
          {
            _tag: 'SetPriorSettlement',
            entries: [{ amountMinor: 1, invoiceResourceId: 'adv-1' }],
            invoiceRef: second.ref,
          },
        ),
      );
      expect(failsWith(twice, 'prior_settlement_exceeds_paid_amount')).toBe(true);
    }),
  );

  it.effect('a standard invoice cannot take earlier advances into account', () =>
    Effect.gen(function* standard() {
      const plain = invoice('std-1', { businessState: 'DRAFT' });
      const refused = yield* Effect.exit(
        run(
          { ...empty, invoices: [advance, plain] },
          {
            _tag: 'SetPriorSettlement',
            entries: [{ amountMinor: 1_000, invoiceResourceId: 'adv-1' }],
            invoiceRef: plain.ref,
          },
        ),
      );
      expect(failsWith(refused, 'prior_settlement_requires_final_or_partial')).toBe(true);
    }),
  );
});

describe('S09 plan items, object budgets, skonto and late interest', () => {
  it.effect('a plan item with probability and relation is validated and weighted into cash-flow', () =>
    Effect.gen(function* planItems() {
      checkedAnchors.length = 0;
      const created = yield* run(empty, {
        _tag: 'UpsertPlanItem',
        amountMinor: 1_000_000,
        currency: 'CZK',
        expectedDate: '2026-11-15',
        kind: 'REVENUE',
        probabilityPercent: 60,
        projectName: 'Rekonstrukce haly B',
        propertyRef,
        title: 'Nájem nové haly',
      });
      expect(checkedAnchors).toEqual([{ propertyRef }]);
      const months = cashFlowMonths(created.state, { businessDate: '2026-10-21', fromMonth: '2026-10', months: 2 });
      expect(months[1]?.planInMinor).toBe(600_000);
      const id = created.state.planItems?.[0]?.id ?? '';
      const deleted = yield* run(created.state, { _tag: 'DeletePlanItem', id });
      expect(deleted.state.planItems).toEqual([]);
    }),
  );

  it.effect('budgets per property or středisko count only invoices of that object', () =>
    Effect.gen(function* budgets() {
      const base = { category: 'Energie', kind: 'COST' as const, period: '2026-10' };
      const invoices = [
        invoice('e-1', { budgetCategory: 'Energie', direction: 'INCOMING', propertyRef, totalMinor: 10_000 }),
        invoice('e-2', { budgetCategory: 'Energie', costCenter: 'Ubytování', direction: 'INCOMING', totalMinor: 5_000 }),
      ];
      expect(invoiceActualMinor(base, invoices)).toBe(15_000);
      expect(invoiceActualMinor({ ...base, propertyRef }, invoices)).toBe(10_000);
      expect(invoiceActualMinor({ ...base, costCenter: 'Ubytování' }, invoices)).toBe(5_000);
      const first = yield* run(empty, { _tag: 'UpsertBudgetLine', ...base, plannedMinor: 20_000, propertyRef });
      const second = yield* run(first.state, { _tag: 'UpsertBudgetLine', ...base, plannedMinor: 9_000 });
      expect(second.state.budgets?.length).toBe(2);
      const clash = yield* Effect.exit(
        run(second.state, { _tag: 'UpsertBudgetLine', ...base, plannedMinor: 1, propertyRef }),
      );
      expect(failsWith(clash, 'budget_line_already_exists')).toBe(true);
    }),
  );

  it.effect('skonto and late interest are stored as text or hand-approved amounts, never computed', () =>
    Effect.gen(function* terms() {
      const state = { ...empty, invoices: [invoice('t-1')] };
      const set = yield* run(state, {
        _tag: 'SetPaymentTerms',
        actorLabel: 'Finance',
        invoiceRef: state.invoices[0]!.ref,
        lateInterestText: 'Smluvní úrok z prodlení 0,05 % denně dle čl. 7 smlouvy',
        skontoApprovedMinor: 2_000,
        skontoText: 'Skonto 2 % při úhradě do 7 dnů',
      });
      expect(set.invoice?.paymentTerms).toMatchObject({
        lateInterestText: 'Smluvní úrok z prodlení 0,05 % denně dle čl. 7 smlouvy',
        skontoApprovedMinor: 2_000,
        updatedByLabel: 'Finance',
      });
      expect(set.invoice?.paidMinor).toBe(0);
      const cleared = yield* run(set.state, { _tag: 'SetPaymentTerms', invoiceRef: state.invoices[0]!.ref });
      expect(cleared.invoice?.paymentTerms).toBe(undefined);
    }),
  );
});

describe('S07.R1 received invoice with lines and object', () => {
  it.effect('a hand-typed supplier invoice stores lines, property, unit and středisko and checks the anchors', () =>
    Effect.gen(function* incoming() {
      checkedAnchors.length = 0;
      const command: FinanceCommand = {
        _tag: 'RecordIncomingInvoice',
        actorLabel: 'Finance',
        budgetCategory: 'Údržba a opravy',
        costCenter: 'Provoz a údržba',
        documentNumber: '2026-1184',
        dueDate: '2026-11-04',
        issueDate: '2026-10-21',
        lines: [{ description: 'Oprava střechy', quantity: 1, unitPriceMinor: 1_000_000, vatRate: 21 }],
        propertyRef,
        supplierName: 'Střechy Novák s.r.o.',
        totalMinor: 1_210_000,
        unitRef,
      };
      const recorded = yield* run(empty, command);
      expect(recorded.invoice).toMatchObject({
        approvedByLabel: 'Finance',
        businessState: 'CONFIRMED',
        costCenter: 'Provoz a údržba',
        counterpartyRef: { resourceId: MANUAL_COUNTERPARTY_ID },
        propertyRef,
        totalMinor: 1_210_000,
        unitRef,
      });
      expect(recorded.invoice?.lines?.length).toBe(1);
      expect(checkedAnchors).toEqual([{ propertyRef, unitRef }]);
      expect(commandReferenceAudiences(command, [])).toEqual(['property-portfolio', 'property-portfolio']);
    }),
  );
});
