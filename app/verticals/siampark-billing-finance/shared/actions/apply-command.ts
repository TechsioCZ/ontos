import { FinanceReferenceUnavailable } from './errors/finance-reference-unavailable.ts';
import { FinancePersistenceUnavailable } from './errors/finance-persistence-unavailable.ts';
import { FinanceNotFound } from './errors/finance-not-found.ts';
import { FinanceConflict } from './errors/finance-conflict.ts';
import { FinanceRejected } from './errors/finance-rejected.ts';
import { Schema } from 'effect';
import { CounterpartyRefSchema } from '@app/party-registry/resources/counterparty';
import { ContractRefSchema } from '@app/siampark-agreements/resources/contract';
import { PropertyRefSchema } from '@app/siampark-property/resources/property';
import { UnitRefSchema } from '@app/siampark-property/resources/unit';
import {
  AccountingExportFormatSchema,
  BudgetKindSchema,
  CalendarMonthSchema,
  FinanceLongTextSchema,
  InvoiceDocumentKindSchema,
  CalendarDateSchema,
  FinanceOpportunityIdSchema,
  FinancePartyIdSchema,
  FinanceTextSchema,
  InvoiceDraftCommandFields,
  InvoiceLinesSchema,
  SourceOrderSchema,
  InvoiceSchema,
  MoneyMinorSchema,
} from '../apis/records.ts';
import { InvoiceRefSchema } from '../resources/invoice.ts';

/** Raw upload limit; the base64 payload is about 4/3 of it. */
export const MAX_DOCUMENT_BYTES = 3 * 1024 * 1024;
export const DocumentUploadSchema = Schema.Struct({
  contentBase64: Schema.String.check(
    Schema.isMinLength(4),
    Schema.isMaxLength(Math.ceil((MAX_DOCUMENT_BYTES * 4) / 3) + 8),
  ),
  fileName: FinanceTextSchema,
  mimeType: FinanceTextSchema,
});
export type DocumentUpload = typeof DocumentUploadSchema.Type;
const actorLabel = Schema.optionalKey(FinanceTextSchema);

export const FinanceCommandSchema = Schema.Union([
  Schema.TaggedStruct('CreateInvoiceDraft', InvoiceDraftCommandFields),
  Schema.TaggedStruct('UpdateInvoiceDraft', { ...InvoiceDraftCommandFields, invoiceRef: InvoiceRefSchema }),
  // Idempotent by opportunityId: a second delivery for the same opportunity returns the existing invoice.
  Schema.TaggedStruct('CreateInvoiceFromOpportunity', {
    issueDate: Schema.optionalKey(CalendarDateSchema),
    lines: InvoiceLinesSchema,
    opportunityId: FinanceOpportunityIdSchema,
    partyId: FinancePartyIdSchema,
  }),
  Schema.TaggedStruct('ConfirmInvoice', { invoiceRef: InvoiceRefSchema }),
  Schema.TaggedStruct('VoidInvoice', { invoiceRef: InvoiceRefSchema }),
  Schema.TaggedStruct('RequestAccountingSync', { invoiceRef: InvoiceRefSchema }),
  Schema.TaggedStruct('RetryAccountingSync', { invoiceRef: InvoiceRefSchema }),
  Schema.TaggedStruct('ApplyAccountingObservation', {
    correlation: FinanceTextSchema,
    invoiceRef: InvoiceRefSchema,
    receipt: Schema.optionalKey(FinanceTextSchema),
    resultId: FinanceTextSchema,
    status: Schema.Literals(['SUCCESS', 'FAILED']),
  }),
  Schema.TaggedStruct('ApplyPaymentObservation', {
    confirmedPaidMinor: MoneyMinorSchema,
    correlation: FinanceTextSchema,
    currency: Schema.Literal('CZK'),
    invoiceRef: InvoiceRefSchema,
    resultId: FinanceTextSchema,
  }),
  // ---- Sales demo v2 (S07 – S09) ----
  /** Received invoice entered by hand, optionally with the scanned/PDF document attached. */
  Schema.TaggedStruct('RecordIncomingInvoice', {
    lines: Schema.optionalKey(InvoiceLinesSchema),
    sourceOrder: Schema.optionalKey(SourceOrderSchema),
    actorLabel,
    budgetCategory: Schema.optionalKey(FinanceTextSchema),
    counterpartyRef: Schema.optionalKey(CounterpartyRefSchema),
    document: Schema.optionalKey(DocumentUploadSchema),
    documentNumber: FinanceTextSchema,
    dueDate: CalendarDateSchema,
    issueDate: CalendarDateSchema,
    note: Schema.optionalKey(FinanceTextSchema),
    propertyRef: Schema.optionalKey(PropertyRefSchema),
    supplierCompanyId: Schema.optionalKey(FinanceTextSchema),
    supplierName: FinanceTextSchema,
    totalMinor: MoneyMinorSchema.check(Schema.isGreaterThan(0)),
  }),
  Schema.TaggedStruct('AttachDocument', { actorLabel, document: DocumentUploadSchema, invoiceRef: InvoiceRefSchema }),
  Schema.TaggedStruct('SetInvoiceDetails', {
    budgetCategory: Schema.optionalKey(FinanceTextSchema),
    documentKind: Schema.optionalKey(InvoiceDocumentKindSchema),
    invoiceRef: InvoiceRefSchema,
  }),
  Schema.TaggedStruct('RecordManualPayment', {
    actorLabel,
    amountMinor: MoneyMinorSchema.check(Schema.isGreaterThan(0)),
    invoiceRef: InvoiceRefSchema,
    note: Schema.optionalKey(FinanceTextSchema),
    paidOn: CalendarDateSchema,
  }),
  Schema.TaggedStruct('RecordReminder', {
    actorLabel,
    invoiceRef: InvoiceRefSchema,
    recipient: FinanceTextSchema,
    text: FinanceLongTextSchema,
  }),
  Schema.TaggedStruct('CreateRecurringTemplate', {
    contractRef: Schema.optionalKey(ContractRefSchema),
    counterpartyName: Schema.optionalKey(FinanceTextSchema),
    counterpartyRef: CounterpartyRefSchema,
    dueDays: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(90)),
    issueDay: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(28)),
    lines: InvoiceLinesSchema,
    name: FinanceTextSchema,
    partyId: Schema.optionalKey(FinancePartyIdSchema),
    propertyRef: Schema.optionalKey(PropertyRefSchema),
    unitRef: Schema.optionalKey(UnitRefSchema),
  }),
  Schema.TaggedStruct('SetRecurringTemplateActive', { active: Schema.Boolean, templateId: FinanceTextSchema }),
  /** S07-05: a second draft for the same template and period needs `confirmDuplicate: true`. */
  Schema.TaggedStruct('GenerateRecurringInvoice', {
    confirmDuplicate: Schema.Boolean,
    period: CalendarMonthSchema,
    templateId: FinanceTextSchema,
  }),
  Schema.TaggedStruct('UpdateAccountingSetup', {
    accountant: Schema.optionalKey(FinanceTextSchema),
    actorLabel,
    approvalDate: Schema.optionalKey(CalendarDateSchema),
    product: Schema.optionalKey(FinanceTextSchema),
    productVersion: Schema.optionalKey(FinanceTextSchema),
    transferFormat: Schema.optionalKey(FinanceTextSchema),
  }),
  Schema.TaggedStruct('CreateAccountingExport', {
    actorLabel,
    /** Display names of registry counterparties keyed by invoice id, as the user saw them. */
    counterpartyNames: Schema.optionalKey(Schema.Record(Schema.String, FinanceTextSchema)),
    format: AccountingExportFormatSchema,
    invoiceResourceIds: Schema.Array(FinanceTextSchema).check(Schema.isMinLength(1), Schema.isMaxLength(1000)),
  }),
  Schema.TaggedStruct('ConfirmAccountingExport', {
    actorLabel,
    evidence: FinanceTextSchema,
    exportId: FinanceTextSchema,
  }),
  Schema.TaggedStruct('UpsertBudgetLine', {
    actorLabel,
    actualManualMinor: Schema.optionalKey(MoneyMinorSchema),
    category: FinanceTextSchema,
    explanation: Schema.optionalKey(FinanceTextSchema),
    id: Schema.optionalKey(FinanceTextSchema),
    kind: BudgetKindSchema,
    period: CalendarMonthSchema,
    plannedMinor: MoneyMinorSchema,
  }),
  Schema.TaggedStruct('DeleteBudgetLine', { id: FinanceTextSchema }),
  Schema.TaggedStruct('SetOpeningBalance', {
    actorLabel,
    openingBalanceMinor: Schema.Int.check(
      Schema.isGreaterThanOrEqualTo(-1_000_000_000_000),
      Schema.isLessThanOrEqualTo(1_000_000_000_000),
    ),
    openingDate: CalendarDateSchema,
  }),
]);
export type FinanceCommand = typeof FinanceCommandSchema.Type;
export const ApplyCommandPayloadSchema = Schema.Struct({
  command: FinanceCommandSchema,
  expectedRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type ApplyCommandPayload = typeof ApplyCommandPayloadSchema.Type;
export const ApplyCommandResultSchema = Schema.Struct({
  changed: Schema.Boolean,
  /** Present for invoice commands; planning, export and setup commands change no invoice. */
  invoice: Schema.optionalKey(InvoiceSchema),
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export const FinanceErrorSchema = Schema.Union([
  FinanceRejected,
  FinanceConflict,
  FinanceNotFound,
  FinancePersistenceUnavailable,
  FinanceReferenceUnavailable,
]);
export type FinanceError = typeof FinanceErrorSchema.Type;

export { FinanceRejected } from './errors/finance-rejected.ts';

export { FinanceConflict } from './errors/finance-conflict.ts';

export { FinanceNotFound } from './errors/finance-not-found.ts';

export { FinancePersistenceUnavailable } from './errors/finance-persistence-unavailable.ts';

export { FinanceReferenceUnavailable } from './errors/finance-reference-unavailable.ts';
