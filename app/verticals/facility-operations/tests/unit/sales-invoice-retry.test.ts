// @rstest-environment happy-dom
import { DateTime, Effect, Predicate, Schema } from 'effect';
import { beforeEach, expect, it, rstest } from 'effect-rstest';
import { CZ_VAT_STANDARD } from '@app/shared-contracts/cz-vat-classifications';
import { SalesOrderSchema } from '../../shared/domain/purchasing.ts';
import { issueSalesInvoice } from '../../src/routes/[lang]/provoz/nakupy/sales-tab.tsx';
import type { FinanceInvoiceView } from '../../src/ui/finance-reads.ts';
import { recordingRunner } from './form-save-fixture.ts';

const { create, read, vat, credentials } = rstest.hoisted(() => ({
  create: rstest.fn(),
  credentials: rstest.fn(),
  read: rstest.fn(),
  vat: rstest.fn(),
}));
rstest.mock('@app/finance-billing/clients/apply-command', () => ({ executeApplyCommand: create }));
rstest.mock('../../src/ui/finance-reads.ts', () => ({ readFinance: read, readFinanceVatChoices: vat }));
rstest.mock('@app/shared-contracts', () => ({
  ...rstest.requireActual<Record<string, unknown>>('@app/shared-contracts'),
  makeReferenceGatewayCredentials: credentials,
}));

const tenantId = '70000000-0000-4000-8000-000000000020';
const actor = { principalId: '72000000-0000-4000-8000-000000000021', tenantId };
const timestamp = '2026-11-14T09:00:00Z';
const issueDate = '2026-11-14';
const order = Schema.decodeUnknownSync(SalesOrderSchema)({
  createdAt: timestamp,
  createdBy: actor,
  currency: 'CZK',
  customer: { counterpartyId: 'customer-1', name: 'Customer', tenantId },
  deliveries: [],
  history: [],
  id: 'order-1',
  invoices: [],
  lines: [
    { deliveredQuantity: 0, description: 'Service', id: 'line-1', quantity: 1, unitPriceMinor: 10_000, vatRate: 21 },
  ],
  number: 'PRO-2026-001',
  status: 'approved',
  updatedAt: timestamp,
  updatedBy: actor,
});
const invoice: FinanceInvoiceView = {
  businessState: 'DRAFT',
  counterpartyRef: { resourceId: 'customer-1' },
  direction: 'OUTGOING',
  documentNumber: 'PRO-2026-001-F1',
  dueDate: issueDate,
  issueDate,
  number: 'FV-2026-001',
  paidMinor: 0,
  paymentState: 'UNPAID',
  ref: { resourceId: 'invoice-1' },
  totalMinor: 12_100,
};
const snapshot = (invoices: readonly FinanceInvoiceView[]) => ({
  canWrite: true,
  revision: 1,
  state: { invoices },
});

beforeEach(() => {
  create.mockReset();
  read.mockReset();
  vat.mockReset();
  credentials.mockReset();
  create.mockReturnValue(Effect.succeed({ invoice }));
  read.mockReturnValue(Effect.succeed(snapshot([])));
  credentials.mockReturnValue(Effect.succeed([]));
  vat.mockReturnValue(
    Effect.succeed({
      on: issueDate,
      rates: [
        {
          code: CZ_VAT_STANDARD,
          effectiveFrom: DateTime.makeUnsafe(timestamp),
          ratePercent: 21,
          taxRuleRevisionRef: {
            moduleId: 'commerce.tax',
            resourceId: 'revision-1',
            resourceType: 'commerce.tax.tax-rule-revision',
            tenantId,
          },
        },
      ],
      regime: 'VAT_PAYER',
    }),
  );
});

it.effect('after a failed link a remounted panel retries only the retained invoice and never creates another', () =>
  Effect.gen(function* retryOnlyLink() {
    const runner = recordingRunner(['unavailable']);
    const pending = new Map<string, FinanceInvoiceView>();
    const busy = { current: false };
    const input = { busy, dueDate: issueDate, issueDate, order, pending, run: runner.run };
    const failed = yield* issueSalesInvoice(input);
    expect(failed).toMatchObject({ number: invoice.number, ok: false, reason: 'link' });
    expect(pending.get(order.id)?.ref.resourceId).toBe(invoice.ref.resourceId);
    expect(busy.current).toBe(false);
    read.mockReturnValue(Effect.succeed(snapshot([invoice])));
    const linked = yield* issueSalesInvoice({ ...input, busy: { current: false }, dueDate: '2026-12-01' });
    expect(linked).toMatchObject({ number: invoice.number, ok: true });
    expect(create.mock.calls).toHaveLength(1);
    expect(vat.mock.calls).toHaveLength(1);
    expect(runner.sent).toHaveLength(2);
    expect(runner.sent[1]).toEqual(runner.sent[0]);
    expect(Predicate.isTagged(runner.sent[1], 'SalesOrderLinkInvoice')).toBe(true);
    // A caller still holding the old order snapshot also links the same invoice, never creates one again.
    yield* issueSalesInvoice(input);
    expect(create.mock.calls).toHaveLength(1);
  }),
);

it.effect('a retained invoice missing from the current authorized Finance scope cannot be linked or recreated', () =>
  Effect.gen(function* retainWithinScope() {
    const runner = recordingRunner();
    const pending = new Map<string, FinanceInvoiceView>([[order.id, invoice]]);
    const outcome = yield* issueSalesInvoice({
      busy: { current: false },
      dueDate: issueDate,
      issueDate,
      order,
      pending,
      run: runner.run,
    });
    expect(outcome.ok).toBe(false);
    expect(create.mock.calls).toHaveLength(0);
    expect(runner.sent).toEqual([]);
    expect(pending.get(order.id)).toEqual(invoice);
  }),
);

it.effect('already linked orders refuse Finance creation before any read or write', () =>
  Effect.gen(function* refuseDuplicate() {
    const runner = recordingRunner();
    const linkedOrder = Schema.decodeUnknownSync(SalesOrderSchema)({
      ...Schema.encodeSync(SalesOrderSchema)(order),
      invoices: [{ invoiceId: invoice.ref.resourceId, linkedAt: timestamp, linkedBy: actor, number: invoice.number }],
    });
    const outcome = yield* issueSalesInvoice({
      busy: { current: false },
      dueDate: issueDate,
      issueDate,
      order: linkedOrder,
      pending: new Map<string, FinanceInvoiceView>(),
      run: runner.run,
    });
    expect(outcome.ok).toBe(false);
    expect(create.mock.calls).toHaveLength(0);
    expect(read.mock.calls).toHaveLength(0);
    expect(runner.sent).toEqual([]);
  }),
);
