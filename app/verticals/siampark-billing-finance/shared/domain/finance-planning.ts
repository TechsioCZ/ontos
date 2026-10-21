import type {
  AccountingExportFormat,
  BudgetLine,
  CashFlowOpening,
  FinanceState,
  Invoice,
  ManualPayment,
  PaymentObservation,
  PlanItem,
} from '../apis/records.ts';
import { DateTime } from 'effect';
import { ACCOUNTING_EXPORT_SCHEMA_VERSION } from '../apis/records.ts';
import { buildPohodaDataPack } from './pohoda-xml.ts';

/** Calendar date (YYYY-MM-DD) of the instant `epochMillis` in Europe/Prague. */
export const pragueCalendarDate = (epochMillis: number): string =>
  new Intl.DateTimeFormat('en-CA', { day: '2-digit', month: '2-digit', timeZone: 'Europe/Prague', year: 'numeric' })
    .format(epochMillis)
    .slice(0, 10);

export const monthOf = (date: string): string => date.slice(0, 7);

export const addMonths = (month: string, count: number): string => {
  const year = Number(month.slice(0, 4));
  const index = Number(month.slice(5, 7)) - 1 + count;
  const targetYear = year + Math.floor(index / 12);
  const targetMonth = ((index % 12) + 12) % 12;
  return `${String(targetYear).padStart(4, '0')}-${String(targetMonth + 1).padStart(2, '0')}`;
};

export const addCalendarDaysTo = (date: string, days: number): string =>
  DateTime.formatIsoDateUtc(DateTime.add(DateTime.makeUnsafe(`${date}T12:00:00.000Z`), { days }));

/** Issue date of a recurring invoice in `period` (YYYY-MM) on `issueDay`. */
export const recurringIssueDate = (period: string, issueDay: number): string =>
  `${period}-${String(issueDay).padStart(2, '0')}`;

/** Remaining amount of a confirmed invoice; drafts and voided invoices have nothing outstanding. */
export const remainingMinor = (invoice: Pick<Invoice, 'businessState' | 'paidMinor' | 'totalMinor'>): number =>
  invoice.businessState === 'CONFIRMED' ? Math.max(0, invoice.totalMinor - invoice.paidMinor) : 0;

export const isInvoiceOverdue = (
  invoice: Pick<Invoice, 'businessState' | 'dueDate' | 'paidMinor' | 'totalMinor'>,
  businessDate: string,
): boolean => remainingMinor(invoice) > 0 && invoice.dueDate < businessDate;

export interface PaymentEvent {
  readonly amountMinor: number;
  readonly date: string;
  readonly direction: Invoice['direction'];
  readonly id: string;
  readonly invoiceResourceId: string;
  /** PRIOR = an earlier advance/partial amount taken into account by hand: it settles, but moves no money. */
  readonly source: 'MANUAL' | 'PRIOR' | 'SIMULATED' | 'SNAPSHOT';
}

const isoDateOf = (value: unknown): string => {
  if (typeof value === 'string') {
    return value.slice(0, 10);
  }
  return DateTime.isDateTime(value) ? DateTime.formatIsoDateUtc(value) : '1970-01-01';
};

/**
 * Every confirmed payment of every invoice exactly once. Simulated observations are cumulative, so each one
 * contributes its increment; manual payments contribute their amount. Whatever part of `paidMinor` no event
 * explains (older seeded snapshots) becomes one SNAPSHOT event, so the sum always equals `paidMinor`.
 */
export const paymentEvents = (
  state: Pick<FinanceState, 'invoices' | 'paymentObservations'> & {
    readonly manualPayments?: readonly ManualPayment[];
  },
): readonly PaymentEvent[] => {
  const events: PaymentEvent[] = [];
  for (const invoice of state.invoices) {
    if (invoice.businessState !== 'CONFIRMED' || invoice.paidMinor === 0) {
      continue;
    }
    const id = invoice.ref.resourceId;
    let explained = 0;
    for (const [index, entry] of (invoice.priorSettlement?.entries ?? []).entries()) {
      events.push({
        amountMinor: entry.amountMinor,
        date: isoDateOf(invoice.approvedAt ?? invoice.priorSettlement?.confirmedAt ?? invoice.updatedAt),
        direction: invoice.direction,
        id: `${id}:prior:${index}`,
        invoiceResourceId: id,
        source: 'PRIOR',
      });
      explained += entry.amountMinor;
    }
    const observations = state.paymentObservations
      .filter((observation: PaymentObservation) => observation.invoiceRef.resourceId === id)
      .map((observation) => ({ amount: observation.confirmedPaidMinor, date: isoDateOf(observation.observedAt) }))
      .sort((left, right) => left.amount - right.amount);
    let cumulative = 0;
    for (const [index, observation] of observations.entries()) {
      const increment = observation.amount - cumulative;
      cumulative = observation.amount;
      if (increment > 0) {
        events.push({
          amountMinor: increment,
          date: observation.date,
          direction: invoice.direction,
          id: `${id}:obs:${index}`,
          invoiceResourceId: id,
          source: 'SIMULATED',
        });
        explained += increment;
      }
    }
    for (const payment of (state.manualPayments ?? []).filter((entry) => entry.invoiceResourceId === id)) {
      events.push({
        amountMinor: payment.amountMinor,
        date: payment.paidOn,
        direction: invoice.direction,
        id: payment.id,
        invoiceResourceId: id,
        source: 'MANUAL',
      });
      explained += payment.amountMinor;
    }
    if (explained < invoice.paidMinor) {
      events.push({
        amountMinor: invoice.paidMinor - explained,
        date: isoDateOf(invoice.updatedAt),
        direction: invoice.direction,
        id: `${id}:snapshot`,
        invoiceResourceId: id,
        source: 'SNAPSHOT',
      });
    }
  }
  return events;
};

/** Plan item amount weighted by its optional probability (absent = certain), rounded to whole haléře. */
export const planItemWeightedMinor = (item: Pick<PlanItem, 'amountMinor' | 'probabilityPercent'>): number =>
  Math.round((item.amountMinor * (item.probabilityPercent ?? 100)) / 100);

/** Signed difference actual − plan and the percentage, which is only defined for a non-zero plan (S09-03). */
export const budgetVariance = (plannedMinor: number, actualMinor: number) => ({
  differenceMinor: actualMinor - plannedMinor,
  percent: plannedMinor === 0 ? undefined : (actualMinor - plannedMinor) / plannedMinor,
});

/**
 * Invoice actual for a budget line: confirmed invoices of that month, category and direction; a budget for a
 * property, unit or středisko only counts invoices assigned to that same object.
 */
export const invoiceActualMinor = (
  budget: Pick<BudgetLine, 'category' | 'kind' | 'period'> &
    Partial<Pick<BudgetLine, 'costCenter' | 'propertyRef' | 'unitRef'>>,
  invoices: readonly Invoice[],
): number =>
  invoices
    .filter(
      (invoice) =>
        invoice.businessState === 'CONFIRMED' &&
        invoice.budgetCategory === budget.category &&
        monthOf(invoice.issueDate) === budget.period &&
        invoice.direction === (budget.kind === 'COST' ? 'INCOMING' : 'OUTGOING') &&
        (budget.propertyRef === undefined || invoice.propertyRef?.resourceId === budget.propertyRef.resourceId) &&
        (budget.unitRef === undefined || invoice.unitRef?.resourceId === budget.unitRef.resourceId) &&
        (budget.costCenter === undefined || invoice.costCenter === budget.costCenter),
    )
    .reduce((sum, invoice) => sum + invoice.totalMinor, 0);

/** The manual actual wins when entered; otherwise the matching confirmed invoices are the actual. */
export const budgetActualMinor = (budget: BudgetLine, invoices: readonly Invoice[]) =>
  budget.actualManualMinor ?? invoiceActualMinor(budget, invoices);

export interface CashFlowMonth {
  readonly expectedInMinor: number;
  readonly expectedOutMinor: number;
  /** Opening + every flow up to and including this month. An estimate, never a bank balance. */
  readonly forecastBalanceMinor: number | undefined;
  readonly month: string;
  readonly netMinor: number;
  readonly paidInMinor: number;
  readonly paidOutMinor: number;
  readonly planInMinor: number;
  readonly planOutMinor: number;
}

/**
 * Monthly cash-flow. Paid = confirmed payment events by payment date. Expected = what is still outstanding on
 * confirmed invoices, by due date (overdue amounts land in the current month). Plan = the part of a budget line
 * not yet covered by its actual, for the current and future months only. A paid amount is therefore never also
 * expected, and an invoice that realises a budget is never counted twice (S09-02).
 */
export const cashFlowMonths = (
  state: Pick<FinanceState, 'invoices' | 'paymentObservations'> & {
    readonly budgets?: readonly BudgetLine[];
    readonly cashFlowOpening?: CashFlowOpening;
    readonly manualPayments?: readonly ManualPayment[];
    readonly planItems?: readonly PlanItem[];
  },
  options: { readonly businessDate: string; readonly fromMonth: string; readonly months: number },
): readonly CashFlowMonth[] => {
  const currentMonth = monthOf(options.businessDate);
  const opening = state.cashFlowOpening;
  const months = Array.from({ length: options.months }, (_, index) => addMonths(options.fromMonth, index));
  const empty = () => ({ expectedIn: 0, expectedOut: 0, paidIn: 0, paidOut: 0, planIn: 0, planOut: 0 });
  const buckets = new Map(months.map((month) => [month, empty()] as const));
  const openingDate = opening?.openingDate;
  for (const event of paymentEvents(state)) {
    // A taken-into-account advance moved its money when the advance itself was paid.
    if (event.source === 'PRIOR' || (openingDate !== undefined && event.date < openingDate)) {
      continue;
    }
    const bucket = buckets.get(monthOf(event.date));
    if (bucket !== undefined) {
      if (event.direction === 'OUTGOING') {
        bucket.paidIn += event.amountMinor;
      } else {
        bucket.paidOut += event.amountMinor;
      }
    }
  }
  for (const invoice of state.invoices) {
    const remaining = remainingMinor(invoice);
    if (remaining === 0) {
      continue;
    }
    const dueMonth = monthOf(invoice.dueDate);
    const bucket = buckets.get(dueMonth < currentMonth ? currentMonth : dueMonth);
    if (bucket !== undefined) {
      if (invoice.direction === 'OUTGOING') {
        bucket.expectedIn += remaining;
      } else {
        bucket.expectedOut += remaining;
      }
    }
  }
  for (const budget of state.budgets ?? []) {
    if (budget.period < currentMonth) {
      continue;
    }
    const bucket = buckets.get(budget.period);
    if (bucket === undefined) {
      continue;
    }
    const uncovered = Math.max(0, budget.plannedMinor - budgetActualMinor(budget, state.invoices));
    if (budget.kind === 'REVENUE') {
      bucket.planIn += uncovered;
    } else {
      bucket.planOut += uncovered;
    }
  }
  // Plan items count with their probability; a past expected date that is still planned lands in this month.
  for (const item of state.planItems ?? []) {
    const month = monthOf(item.expectedDate);
    const bucket = buckets.get(month < currentMonth ? currentMonth : month);
    if (bucket === undefined) {
      continue;
    }
    const weighted = planItemWeightedMinor(item);
    if (item.kind === 'REVENUE') {
      bucket.planIn += weighted;
    } else {
      bucket.planOut += weighted;
    }
  }
  let balance = opening?.openingBalanceMinor;
  const openingMonth = openingDate === undefined ? undefined : monthOf(openingDate);
  return months.map((month) => {
    const bucket = buckets.get(month) ?? empty();
    const netMinor =
      bucket.paidIn + bucket.expectedIn + bucket.planIn - bucket.paidOut - bucket.expectedOut - bucket.planOut;
    const counts = balance !== undefined && openingMonth !== undefined && month >= openingMonth;
    if (counts && balance !== undefined) {
      balance += netMinor;
    }
    return {
      expectedInMinor: bucket.expectedIn,
      expectedOutMinor: bucket.expectedOut,
      forecastBalanceMinor: counts ? balance : undefined,
      month,
      netMinor,
      paidInMinor: bucket.paidIn,
      paidOutMinor: bucket.paidOut,
      planInMinor: bucket.planIn,
      planOutMinor: bucket.planOut,
    };
  });
};

const csvCell = (value: string | number | undefined) => {
  const text = value === undefined ? '' : String(value);
  return /[";\n\r]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};

const amount = (minor: number | undefined) => (minor === undefined ? '' : (minor / 100).toFixed(2));

/** Accounting unit that issues / receives the exported invoices: the selected legal entity. */
export interface ExportIssuer {
  readonly city?: string;
  readonly ico?: string;
  readonly name?: string;
  readonly street?: string;
  readonly vatId?: string;
  readonly zip?: string;
}

/** Registry identity of the invoice counterparty, when known. */
export interface ExportPartnerIdentity {
  readonly city?: string;
  readonly ico?: string;
  readonly vatId?: string;
}

export interface ExportMeta {
  readonly batchNumber: string;
  readonly createdAt: string;
  readonly createdBy: string;
  readonly issuer?: ExportIssuer;
  readonly version: number;
}

export interface ExportRow {
  readonly counterpartyName: string;
  readonly documentLink: string;
  readonly invoice: Invoice;
  readonly partner?: ExportPartnerIdentity;
}

export const exportFileName = (format: AccountingExportFormat, meta: Pick<ExportMeta, 'batchNumber' | 'version'>) =>
  `${meta.batchNumber}-v${meta.version}.${format === 'CSV' ? 'csv' : format === 'JSON' ? 'json' : 'xml'}`;

const objectLabel = (invoice: Invoice) =>
  [invoice.propertyRef?.resourceId, invoice.unitRef?.resourceId, invoice.costCenter, invoice.budgetCategory]
    .filter((part) => part !== undefined)
    .join(' / ');

/** Builds the exact handover file. CSV/JSON carry the OntOS schema version; POHODA_XML is a STORMWARE dataPack. */
export const buildAccountingExport = (
  format: AccountingExportFormat,
  rows: readonly ExportRow[],
  meta: ExportMeta,
): string => {
  if (format === 'CSV') {
    const header = [
      'schema_version',
      'batch',
      'batch_version',
      'invoice_id',
      'number',
      'document_kind',
      'direction',
      'counterparty',
      'counterparty_ref',
      'issue_date',
      'due_date',
      'currency',
      'subtotal',
      'vat',
      'total',
      'paid',
      'payment_state',
      'object',
      'document_link',
    ];
    const lines = rows.map(({ counterpartyName, documentLink, invoice }) =>
      [
        ACCOUNTING_EXPORT_SCHEMA_VERSION,
        meta.batchNumber,
        meta.version,
        invoice.ref.resourceId,
        invoice.number ?? invoice.documentNumber,
        invoice.documentKind ?? 'STANDARD',
        invoice.direction === 'OUTGOING' ? 'VYDANA' : 'PRIJATA',
        counterpartyName,
        invoice.counterpartyRef.resourceId,
        invoice.issueDate,
        invoice.dueDate,
        invoice.currency,
        amount(invoice.subtotalMinor),
        amount(invoice.vatMinor),
        amount(invoice.totalMinor),
        amount(invoice.paidMinor),
        invoice.paymentState,
        objectLabel(invoice),
        documentLink,
      ]
        .map(csvCell)
        .join(';'),
    );
    return `﻿${[header.join(';'), ...lines].join('\r\n')}\r\n`;
  }
  if (format === 'JSON') {
    return `${JSON.stringify(
      {
        batch: meta.batchNumber,
        batchVersion: meta.version,
        createdAt: meta.createdAt,
        createdBy: meta.createdBy,
        documents: rows.map(({ counterpartyName, documentLink, invoice }) => ({
          counterparty: counterpartyName,
          counterpartyRef: invoice.counterpartyRef.resourceId,
          currency: invoice.currency,
          direction: invoice.direction,
          documentKind: invoice.documentKind ?? 'STANDARD',
          documentLink,
          dueDate: invoice.dueDate,
          id: invoice.ref.resourceId,
          issueDate: invoice.issueDate,
          number: invoice.number ?? invoice.documentNumber,
          object: objectLabel(invoice),
          paid: amount(invoice.paidMinor),
          paymentState: invoice.paymentState,
          subtotal: amount(invoice.subtotalMinor),
          total: amount(invoice.totalMinor),
          vat: amount(invoice.vatMinor),
        })),
        note: 'Předávací balíček pro účetní. Nejde o potvrzení zaúčtování.',
        schemaVersion: ACCOUNTING_EXPORT_SCHEMA_VERSION,
      },
      null,
      2,
    )}\n`;
  }
  return buildPohodaDataPack(rows, meta);
};

const czk = (minor: number) =>
  `${new Intl.NumberFormat('cs-CZ', { maximumFractionDigits: 2, minimumFractionDigits: 2 }).format(minor / 100)} Kč`;

/**
 * A reminder sent to a reserved test domain (RFC 2606/6761: `.invalid`, `.example`, `.test`, `.localhost`,
 * `example.com/.net/.org`) was a test of the e-mail path, not a reminder to the customer. The audit record stays;
 * the demo view only keeps it out of the customer's reminder list.
 */
export const isTestReminderRecipient = (recipient: string) => {
  const domain = recipient.trim().toLowerCase().split('@').at(-1) ?? '';
  return /(?:^|\.)(?:invalid|example|test|localhost)$/u.test(domain) || /(?:^|\.)example\.(?:com|net|org)$/u.test(domain);
};

/** Simple Czech reminder template (S07.R7). */
export const reminderText = (input: {
  readonly businessDate: string;
  readonly counterpartyName: string;
  readonly invoice: Pick<Invoice, 'documentNumber' | 'dueDate' | 'number' | 'paidMinor' | 'totalMinor'>;
  readonly senderName: string;
}): string => {
  const number = input.invoice.number ?? input.invoice.documentNumber;
  const remaining = Math.max(0, input.invoice.totalMinor - input.invoice.paidMinor);
  const [year, month, day] = input.invoice.dueDate.split('-');
  return `Dobrý den,

dovolujeme si Vás upozornit, že faktura č. ${number} se splatností ${Number(day)}. ${Number(month)}. ${year} dosud není zcela uhrazena. Zbývá uhradit ${czk(remaining)}.

Prosíme o úhradu v nejbližším možném termínu. Pokud jste platbu již odeslali, považujte prosím tuto zprávu za bezpředmětnou.

S pozdravem
${input.senderName}`;
};
