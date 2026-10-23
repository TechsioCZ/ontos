import { FinanceReferenceUnavailable } from './errors/finance-reference-unavailable.ts';
import { FinancePersistenceUnavailable } from './errors/finance-persistence-unavailable.ts';
import { FinanceNotFound } from './errors/finance-not-found.ts';
import { FinanceConflict } from './errors/finance-conflict.ts';
import { FinanceRejected } from './errors/finance-rejected.ts';
import { Schema } from 'effect';
import { CounterpartyRefSchema } from '@app/party-registry/resources/counterparty';
import { OccupancyRefSchema } from '@app/property-leasing/resources/occupancy';
import { ContractRefSchema } from '@app/legal-agreements/resources/contract';
import { PropertyRefSchema } from '@app/property-portfolio/resources/property';
import { UnitRefSchema } from '@app/property-portfolio/resources/unit';
import {
  AccountingExportFormatSchema,
  AccountingIssuerFields,
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
  VatRateSchema,
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
/** Optional draft extras the create/update forms send next to the core draft fields. */
const DraftExtras = {
  costCenter: Schema.optionalKey(FinanceTextSchema),
  documentKind: Schema.optionalKey(InvoiceDocumentKindSchema),
};
const AnchorFields = {
  contractRef: Schema.optionalKey(ContractRefSchema),
  propertyRef: Schema.optionalKey(PropertyRefSchema),
  unitRef: Schema.optionalKey(UnitRefSchema),
};

export const FinanceCommandSchema = Schema.Union([
  Schema.TaggedStruct('CreateInvoiceDraft', { ...InvoiceDraftCommandFields, ...DraftExtras }),
  Schema.TaggedStruct('UpdateInvoiceDraft', {
    ...InvoiceDraftCommandFields,
    ...DraftExtras,
    invoiceRef: InvoiceRefSchema,
  }),
  // Idempotent by opportunityId: a second delivery for the same opportunity returns the existing invoice.
  Schema.TaggedStruct('CreateInvoiceFromOpportunity', {
    issueDate: Schema.optionalKey(CalendarDateSchema),
    lines: InvoiceLinesSchema,
    opportunityId: FinanceOpportunityIdSchema,
    partyId: FinancePartyIdSchema,
  }),
  /** S07.R5 "schváleno": approves (issues) a draft or a prepared draft. */
  Schema.TaggedStruct('ConfirmInvoice', { actorLabel, invoiceRef: InvoiceRefSchema }),
  /** S07.R3 bulk step: moves the selected drafts to "připraveno k odsouhlasení" without closing them. */
  Schema.TaggedStruct('MarkInvoicesPrepared', {
    actorLabel,
    invoiceRefs: Schema.Array(InvoiceRefSchema).check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  }),
  Schema.TaggedStruct('ReturnInvoiceToDraft', { invoiceRef: InvoiceRefSchema }),
  /** S07.R2: earlier advance/partial amounts a final or partial draft takes into account, confirmed by hand. */
  Schema.TaggedStruct('SetPriorSettlement', {
    actorLabel,
    entries: Schema.Array(
      Schema.Struct({
        amountMinor: MoneyMinorSchema.check(Schema.isGreaterThan(0)),
        invoiceResourceId: FinanceTextSchema,
      }),
    ).check(Schema.isMaxLength(20)),
    invoiceRef: InvoiceRefSchema,
    note: Schema.optionalKey(FinanceTextSchema),
  }),
  /** S09: skonto and agreed late-payment interest as text or hand-approved amounts; never computed. */
  Schema.TaggedStruct('SetPaymentTerms', {
    actorLabel,
    invoiceRef: InvoiceRefSchema,
    lateInterestApprovedMinor: Schema.optionalKey(MoneyMinorSchema),
    lateInterestText: Schema.optionalKey(FinanceTextSchema),
    skontoApprovedMinor: Schema.optionalKey(MoneyMinorSchema),
    skontoText: Schema.optionalKey(FinanceTextSchema),
  }),
  Schema.TaggedStruct('VoidInvoice', { invoiceRef: InvoiceRefSchema }),
  // ---- Sales demo v2 (S07 – S09) ----
  /** Received invoice entered by hand, optionally with the scanned/PDF document attached. */
  Schema.TaggedStruct('RecordIncomingInvoice', {
    lines: Schema.optionalKey(InvoiceLinesSchema),
    sourceOrder: Schema.optionalKey(SourceOrderSchema),
    actorLabel,
    budgetCategory: Schema.optionalKey(FinanceTextSchema),
    costCenter: Schema.optionalKey(FinanceTextSchema),
    counterpartyRef: Schema.optionalKey(CounterpartyRefSchema),
    document: Schema.optionalKey(DocumentUploadSchema),
    documentNumber: FinanceTextSchema,
    dueDate: CalendarDateSchema,
    issueDate: CalendarDateSchema,
    note: Schema.optionalKey(FinanceTextSchema),
    propertyRef: Schema.optionalKey(PropertyRefSchema),
    unitRef: Schema.optionalKey(UnitRefSchema),
    supplierCompanyId: Schema.optionalKey(FinanceTextSchema),
    supplierName: FinanceTextSchema,
    totalMinor: MoneyMinorSchema.check(Schema.isGreaterThan(0)),
  }),
  Schema.TaggedStruct('AttachDocument', { actorLabel, document: DocumentUploadSchema, invoiceRef: InvoiceRefSchema }),
  Schema.TaggedStruct('SetInvoiceDetails', {
    budgetCategory: Schema.optionalKey(FinanceTextSchema),
    costCenter: Schema.optionalKey(FinanceTextSchema),
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
    occupancyRef: Schema.optionalKey(OccupancyRefSchema),
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
    ...AccountingIssuerFields,
    accountant: Schema.optionalKey(FinanceTextSchema),
    actorLabel,
    approvalDate: Schema.optionalKey(CalendarDateSchema),
    product: Schema.optionalKey(FinanceTextSchema),
    productVersion: Schema.optionalKey(FinanceTextSchema),
    transferFormat: Schema.optionalKey(FinanceTextSchema),
  }),
  Schema.TaggedStruct('CreateAccountingExport', {
    /** Readable author shown in the history; the file itself names the authenticated principal. */
    actorLabel,
    format: AccountingExportFormatSchema,
    // Issuer name and partner identities are resolved by the server (Core legal entity, party registry).
    invoiceResourceIds: Schema.Array(FinanceTextSchema).check(Schema.isMinLength(1), Schema.isMaxLength(1000)),
  }),
  Schema.TaggedStruct('HandOverAccountingExport', { actorLabel, exportId: FinanceTextSchema }),
  Schema.TaggedStruct('MarkAccountingExportFailed', {
    actorLabel,
    exportId: FinanceTextSchema,
    reason: FinanceTextSchema,
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
    costCenter: Schema.optionalKey(FinanceTextSchema),
    explanation: Schema.optionalKey(FinanceTextSchema),
    id: Schema.optionalKey(FinanceTextSchema),
    kind: BudgetKindSchema,
    period: CalendarMonthSchema,
    plannedMinor: MoneyMinorSchema,
    propertyRef: Schema.optionalKey(PropertyRefSchema),
    unitRef: Schema.optionalKey(UnitRefSchema),
  }),
  Schema.TaggedStruct('DeleteBudgetLine', { id: FinanceTextSchema }),
  Schema.TaggedStruct('UpsertPlanItem', {
    ...AnchorFields,
    actorLabel,
    amountMinor: MoneyMinorSchema.check(Schema.isGreaterThan(0)),
    currency: Schema.Literal('CZK'),
    expectedDate: CalendarDateSchema,
    id: Schema.optionalKey(FinanceTextSchema),
    kind: BudgetKindSchema,
    note: Schema.optionalKey(FinanceTextSchema),
    probabilityPercent: Schema.optionalKey(
      Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(100)),
    ),
    projectName: Schema.optionalKey(FinanceTextSchema),
    title: FinanceTextSchema,
  }),
  Schema.TaggedStruct('DeletePlanItem', { id: FinanceTextSchema }),
  Schema.TaggedStruct('UpsertPriceListItem', {
    actorLabel,
    active: Schema.Boolean,
    code: Schema.optionalKey(FinanceTextSchema),
    id: Schema.optionalKey(FinanceTextSchema),
    name: FinanceTextSchema,
    unit: Schema.optionalKey(FinanceTextSchema),
    unitPriceMinor: MoneyMinorSchema,
    vatRate: VatRateSchema,
  }),
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
