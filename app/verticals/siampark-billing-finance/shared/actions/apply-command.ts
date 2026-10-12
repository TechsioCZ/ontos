import { FinanceReferenceUnavailable } from './errors/finance-reference-unavailable.ts';
import { FinancePersistenceUnavailable } from './errors/finance-persistence-unavailable.ts';
import { FinanceNotFound } from './errors/finance-not-found.ts';
import { FinanceConflict } from './errors/finance-conflict.ts';
import { FinanceRejected } from './errors/finance-rejected.ts';
import { Schema } from 'effect';
import { FinanceTextSchema, InvoiceDraftFields, InvoiceSchema, MoneyMinorSchema } from '../apis/records.ts';
import { InvoiceRefSchema } from '../resources/invoice.ts';

export const FinanceCommandSchema = Schema.Union([
  Schema.TaggedStruct('CreateInvoiceDraft', InvoiceDraftFields),
  Schema.TaggedStruct('UpdateInvoiceDraft', { ...InvoiceDraftFields, invoiceRef: InvoiceRefSchema }),
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
]);
export type FinanceCommand = typeof FinanceCommandSchema.Type;
export const ApplyCommandPayloadSchema = Schema.Struct({
  command: FinanceCommandSchema,
  expectedRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type ApplyCommandPayload = typeof ApplyCommandPayloadSchema.Type;
export const ApplyCommandResultSchema = Schema.Struct({
  changed: Schema.Boolean,
  invoice: InvoiceSchema,
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
