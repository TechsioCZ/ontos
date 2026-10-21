import type { OpportunityStageChangedLine, OutboxPayload } from '@app/sales-pipeline/outbox/opportunity-stage-changed';
import { DateTime, Option, Schema } from 'effect';
import type { FinanceCommand } from '../actions/apply-command.ts';
import { VatRateSchema } from '../apis/records.ts';
import type { InvoiceLine, VatRate } from '../apis/records.ts';

export type CreateInvoiceFromOpportunityCommand = Extract<
  FinanceCommand,
  { readonly _tag: 'CreateInvoiceFromOpportunity' }
>;

/** Czech VAT rates are 0, 10, 12 or 21 %; any other producer rate falls back to the standard 21 %. */
export const STANDARD_VAT_RATE: VatRate = 21;
const isVatRate = Schema.is(VatRateSchema);
export const narrowVatRate = (rate: number): VatRate => (isVatRate(rate) ? rate : STANDARD_VAT_RATE);

const invoiceLine = (line: OpportunityStageChangedLine): InvoiceLine => ({
  description: line.productName,
  productId: line.productId,
  quantity: line.quantity,
  unitPriceMinor: line.unitPriceMinor,
  vatRate: narrowVatRate(line.vatRate),
});

/**
 * Maps a sales-pipeline stage change to the billing command. Only WON drafts an invoice, from the price
 * snapshot carried by the message (never the current catalog). The invoice is issued on the day the
 * opportunity was won, so every redelivery maps to the identical command; CreateInvoiceFromOpportunity is
 * idempotent by opportunityId. Other stages, and a WON without lines, map to none (no invoice).
 */
export const opportunityWonInvoiceCommand = (
  payload: OutboxPayload,
): Option.Option<CreateInvoiceFromOpportunityCommand> => {
  const [first, ...rest] = payload.lines;
  if (payload.toStage !== 'WON' || first === undefined) {
    return Option.none();
  }
  return Option.some({
    _tag: 'CreateInvoiceFromOpportunity',
    issueDate: DateTime.formatIsoDateUtc(DateTime.makeUnsafe(payload.changedAt)),
    lines: [invoiceLine(first), ...rest.map(invoiceLine)],
    opportunityId: payload.opportunityId,
    partyId: payload.partyId,
  });
};
