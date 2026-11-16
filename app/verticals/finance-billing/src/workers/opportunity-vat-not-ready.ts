import { Schema } from 'effect';

/**
 * Tax answered that the opportunity's company is not ready for VAT: no declared regime, no rate for a line's
 * classification, or Tax not installed for the Tenant. `firstNotReadyAt` and `over` are where its recorded wait stands
 * (`OpportunityInvoiceLedger.vatNotReady`).
 */
export class OpportunityVatNotReady extends Schema.TaggedError<OpportunityVatNotReady>()('OpportunityVatNotReady', {
  firstNotReadyAt: Schema.DateTimeUtc,
  over: Schema.Boolean,
  reason: Schema.String,
}) {}
