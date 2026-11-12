import type { OpportunityStageChangedLine, OutboxPayload } from '@app/sales-pipeline/outbox/opportunity-stage-changed';
import { DateTime, Option } from 'effect';
import type { FinanceCommand } from '../actions/apply-command.ts';
import type { InvoiceLine, OpportunityLeftWon } from '../apis/records.ts';
import { classificationOfStoredRate } from '../domain/line-vat.ts';

export type CreateInvoiceFromOpportunityCommand = Extract<
  FinanceCommand,
  { readonly _tag: 'CreateInvoiceFromOpportunity' }
>;

/**
 * The opportunity's line as a draft invoice line. Its rate is the one the opportunity was won with; 21 % and 12 % name
 * the standard and the reduced classification. The draft gets Tax's current rate when someone edits it.
 */
const invoiceLine = (line: OpportunityStageChangedLine): InvoiceLine => {
  const classification = classificationOfStoredRate(line.vatRate);
  const snapshot: InvoiceLine = {
    description: line.productName,
    productId: line.productId,
    quantity: line.quantity,
    unitPriceMinor: line.unitPriceMinor,
    vatRate: line.vatRate,
  };
  return classification === undefined ? snapshot : { ...snapshot, vatClassification: classification };
};

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

/**
 * A stage change that takes a won opportunity out of WON (lost, or reopened to an earlier stage), stamped with the
 * Sales Pipeline revision of that change. Sales Pipeline publishes every transition on this one topic, so the won
 * message and the later change reach the same worker; none for every other change.
 */
export const opportunityLeftWon = (payload: OutboxPayload): Option.Option<OpportunityLeftWon> =>
  payload.fromStage === 'WON' && payload.toStage !== 'WON'
    ? Option.some({
        leftAt: DateTime.makeUnsafe(payload.changedAt),
        opportunityId: payload.opportunityId,
        revision: payload.revision,
      })
    : Option.none();
