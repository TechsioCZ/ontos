/*
 * Ledgers of the imported-payment-records migration test, as JSON stored in `finance_billing.finance_states`. Nothing
 * is built when this module loads: every builder is a function the test calls.
 *
 * A valid ledger is a complete encoded Finance ledger that `FinanceStateSchema` decodes. A raw ledger is a valid one
 * with one stored value replaced by something Finance never writes but may hold (a timestamp only JavaScript
 * normalises, an invoice reference with surrounding whitespace); it is written to the table as it is, never through
 * the schema, which would not produce it.
 */
import { DateTime } from 'effect';
import type { FinanceStateSchema } from '../../shared/apis/records.ts';

export type EncodedState = typeof FinanceStateSchema.Encoded;
type EncodedInvoice = EncodedState['invoices'][number];
type EncodedPayment = NonNullable<EncodedState['manualPayments']>[number];

export interface StoredLedger {
  readonly legalEntityId: string;
  readonly name: string;
  readonly revision: number;
  /** What the row holds: an encoded ledger, or one with a stored value Finance never writes but reads. */
  readonly state: EncodedState;
  readonly tenantId: string;
}

export const companyOf = (index: number) => ({
  legalEntityId: `b0000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
  tenantId: `a0000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
});

const invoice = (
  tenantId: string,
  id: string,
  overrides: Partial<Pick<EncodedInvoice, 'paidMinor' | 'paymentState' | 'updatedAt'>> = {},
): EncodedInvoice => ({
  accountingCorrelation: `acc-${id}`,
  accountingSyncState: 'NOT_SYNCED',
  businessState: 'CONFIRMED',
  counterpartyRef: {
    moduleId: 'party.registry',
    resourceId: 'c0000000-0000-4000-8000-000000000001',
    resourceType: 'party.registry.counterparty',
    tenantId,
  },
  createdAt: '2025-12-01T09:00:00.000Z',
  currency: 'CZK',
  direction: 'OUTGOING',
  documentNumber: `FV-${id}`,
  dueDate: '2026-12-31',
  issueDate: '2025-12-01',
  paidMinor: 0,
  paymentState: 'UNPAID',
  ref: { moduleId: 'finance.billing', resourceId: id, resourceType: 'finance.billing.invoice', tenantId },
  totalMinor: 121_000,
  updatedAt: '2025-12-01T09:00:00.000Z',
  ...overrides,
});

const payment = (invoiceId: string, id: string, amountMinor: number, paidOn: string): EncodedPayment => ({
  amountMinor,
  id,
  invoiceResourceId: invoiceId,
  paidOn,
  recordedAt: `${paidOn}T10:00:00.000Z`,
});

const stored = (index: number, name: string, revision: number, state: EncodedState): StoredLedger => ({
  ...companyOf(index),
  name,
  revision,
  state,
});

/** The ledger with each invoice's stored values replaced; encoded values are plain strings, so any string fits. */
const withInvoiceValues = (
  ledger: StoredLedger,
  replace: (stored: EncodedInvoice) => EncodedInvoice,
): StoredLedger => ({ ...ledger, state: { ...ledger.state, invoices: ledger.state.invoices.map(replace) } });

/** The 24 import dates of stage ledger A, 2025-12-06 … 2026-10-13. */
export const salesImportDays = (): readonly string[] =>
  Array.from({ length: 24 }, (_, index) =>
    DateTime.formatIsoDateUtc(
      DateTime.add(DateTime.makeUnsafe('2025-12-06T12:00:00.000Z'), { days: Math.round((index * 311) / 23) }),
    ),
  );

/** Stage ledger A: 30 invoices, 24 paid (18 in full, 6 in half), no payment list at all, revision 5. */
export const salesLedger = (): StoredLedger => {
  const { tenantId } = companyOf(1);
  const days = salesImportDays();
  return {
    ...companyOf(1),
    name: 'sales ledger with paid balances and no payment list',
    revision: 5,
    state: {
      financialPlanEntries: [],
      invoices: Array.from({ length: 30 }, (_, index) => {
        const id = `sales-${String(index + 1).padStart(2, '0')}`;
        const day = days[index];
        if (day === undefined) {
          return invoice(tenantId, id, { updatedAt: '2026-10-13T12:00:00.000Z' });
        }
        const half = index % 4 === 3;
        return invoice(tenantId, id, {
          paidMinor: half ? 60_500 : 121_000,
          paymentState: half ? 'PARTIALLY_PAID' : 'PAID',
          updatedAt: `${day}T12:00:00.000Z`,
        });
      }),
    },
  };
};

/** Stage ledger B: 14 invoices, 9 paid, each paid amount explained by its own payment record, revision 75. */
export const recordedLedger = (): StoredLedger => {
  const { tenantId } = companyOf(2);
  return {
    ...companyOf(2),
    name: 'ledger whose payment records explain every paid amount',
    revision: 75,
    state: {
      financialPlanEntries: [],
      invoices: Array.from({ length: 14 }, (_, index) =>
        index < 9
          ? invoice(tenantId, `rec-${index + 1}`, { paidMinor: 121_000, paymentState: 'PAID' })
          : invoice(tenantId, `rec-${index + 1}`),
      ),
      manualPayments: Array.from({ length: 9 }, (_, index) =>
        payment(`rec-${index + 1}`, `payment-${index + 1}`, 121_000, '2026-01-15'),
      ),
    },
  };
};

/** Timestamps Finance reads besides a plain UTC instant: invoice, stored `updatedAt`, the UTC day Finance reads. */
const oddDay = '2026-09-10';
export const oddStamps = [
  ['date-only', oddDay, oddDay],
  ['no-offset', `${oddDay}T12:00:00`, oddDay],
  ['offset-past-midnight', `${oddDay}T23:30:00-02:00`, '2026-09-11'],
  ['finer-fraction', `${oddDay}T23:59:59.9999999Z`, oddDay],
] as const;

export const oddStampLedger = (): StoredLedger => {
  const { tenantId } = companyOf(3);
  return {
    ...companyOf(3),
    name: 'ledger with timestamps Finance reads',
    revision: 3,
    state: {
      financialPlanEntries: [],
      invoices: oddStamps.map(([id, updatedAt]) =>
        invoice(tenantId, id, { paidMinor: 1000, paymentState: 'PARTIALLY_PAID', updatedAt }),
      ),
    },
  };
};

/** 4,999 payment records on one invoice and `extra` invoices with one unrecorded paid amount each. */
const limitState = (tenantId: string, extra: number): EncodedState => ({
  financialPlanEntries: [],
  invoices: [
    invoice(tenantId, 'many', { paidMinor: 4999, paymentState: 'PARTIALLY_PAID' }),
    ...Array.from({ length: extra }, (_, index) =>
      invoice(tenantId, `one-${index + 1}`, { paidMinor: 100, paymentState: 'PARTIALLY_PAID' }),
    ),
  ],
  manualPayments: Array.from({ length: 4999 }, (_, index) => payment('many', `many-${index + 1}`, 1, '2026-02-01')),
});

/** Exactly 5,000 payment records after the migration. */
export const limitLedger = (): StoredLedger => ({
  ...companyOf(4),
  name: 'ledger reaching exactly 5000 payment records',
  revision: 9,
  state: limitState(companyOf(4).tenantId, 1),
});

/** Ledgers the migration changes or leaves, all valid. */
export const acceptedLedgers = () => [salesLedger(), recordedLedger(), oddStampLedger(), limitLedger()];

/** Each refused ledger is one Finance itself decodes: the migration refuses rather than make it unreadable. */
export interface Refusal {
  readonly build: () => StoredLedger;
  readonly name: string;
  readonly problem: string;
}

export const refusals: readonly Refusal[] = [
  {
    build: () =>
      withInvoiceValues(
        stored(5, 'invalid calendar date', 2, {
          financialPlanEntries: [],
          invoices: [invoice(companyOf(5).tenantId, 'feb-30', { paidMinor: 1000, paymentState: 'PARTIALLY_PAID' })],
        }),
        (entry) => ({ ...entry, updatedAt: '2026-02-30T12:00:00Z' }),
      ),
    name: 'a timestamp Finance reads but PostgreSQL cannot convert',
    problem: 'invoice feb-30 cannot become a payment record: its updatedAt cannot be read as an instant',
  },
  {
    build: () =>
      stored(6, 'taken record id', 2, {
        financialPlanEntries: [],
        invoices: [
          invoice(companyOf(6).tenantId, 'paid', { paidMinor: 1000, paymentState: 'PARTIALLY_PAID' }),
          invoice(companyOf(6).tenantId, 'other', { paidMinor: 500, paymentState: 'PARTIALLY_PAID' }),
        ],
        manualPayments: [payment('other', 'paid:import', 500, '2026-03-01')],
      }),
    name: 'a record id that is already taken',
    problem: 'invoice paid cannot become a payment record: a payment record already has the id paid:import',
  },
  {
    build: () => stored(7, 'one record past the limit', 9, limitState(companyOf(7).tenantId, 2)),
    name: 'a ledger past 5000 payment records',
    problem: 'invoice one-1 cannot become a payment record: the ledger would hold more than 5000 payment records',
  },
  {
    build: () =>
      withInvoiceValues(
        stored(8, 'tab-only reference', 2, {
          financialPlanEntries: [],
          invoices: [invoice(companyOf(8).tenantId, 'tab', { paidMinor: 1000, paymentState: 'PARTIALLY_PAID' })],
        }),
        (entry) => ({ ...entry, ref: { ...entry.ref, resourceId: '\t' } }),
      ),
    name: 'an invoice reference that is only a tab',
    problem: 'cannot become a payment record: its reference is empty or has surrounding whitespace',
  },
  {
    build: () =>
      withInvoiceValues(
        stored(9, 'padded reference', 2, {
          financialPlanEntries: [],
          invoices: [invoice(companyOf(9).tenantId, 'invoice-1', { paidMinor: 1000, paymentState: 'PARTIALLY_PAID' })],
        }),
        (entry) => ({ ...entry, ref: { ...entry.ref, resourceId: ' invoice-1 ' } }),
      ),
    name: 'an invoice reference with surrounding spaces',
    problem: 'invoice  invoice-1  cannot become a payment record: its reference is empty or has surrounding whitespace',
  },
];

export const MIGRATION = 'drizzle/20261116003317_imported-payment-records/migration.sql';
export const PROBE_TABLE = 'pg_temp.finance_states_payment_probe';
const LEDGER_TABLE = '"finance_billing"."finance_states"';

/**
 * The migration's statements against the probe table, as the migrator sends them, or what is wrong with its text: no
 * trigger or function outlives it, saves wait from before the records are computed, every check comes before the
 * only write, and once the table is the probe nothing names Finance's schema.
 */
export const probeStatements = (migration: string) => {
  const lockAt = migration.indexOf(`LOCK TABLE ${LEDGER_TABLE} IN SHARE ROW EXCLUSIVE MODE`);
  const updates = migration.match(/^UPDATE /gmu) ?? [];
  const problems = [
    ...(migration.includes(LEDGER_TABLE) ? [] : ['the Finance ledger table is not named']),
    ...(/CREATE (?:FUNCTION|TRIGGER)/u.test(migration) ? ['a function or trigger is created'] : []),
    ...(lockAt !== -1 && lockAt < migration.indexOf('CREATE TEMP TABLE') ? [] : ['the lock comes after the reads']),
    ...(updates.length === 1 ? [] : [`${updates.length} UPDATE statements`]),
    ...(migration.indexOf('RAISE EXCEPTION') < migration.indexOf(`UPDATE ${LEDGER_TABLE}`)
      ? []
      : ['a check follows the write']),
  ];
  const probe = migration.replaceAll(LEDGER_TABLE, PROBE_TABLE);
  return {
    problems: probe.includes('finance_billing') ? [...problems, 'the probe still names finance_billing'] : problems,
    statements: probe.split('--> statement-breakpoint'),
  };
};
