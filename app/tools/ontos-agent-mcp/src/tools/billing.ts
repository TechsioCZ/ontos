import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { INVOICE_STATE_CS, labelOf, PAYMENT_STATE_CS } from './labels.ts';
import { czkFromMinor, defineTool, readRecordsOf, VERTICAL } from './shared.ts';
import { BillingRecordsWire } from './wire.ts';

export const INVOICE_STATES = ['DRAFT', 'CONFIRMED', 'VOIDED'] as const;
export const PAYMENT_STATES = ['UNPAID', 'PARTIALLY_PAID', 'PAID'] as const;

export const listInvoicesInput = {
  payment: z.enum(PAYMENT_STATES).optional().describe('Payment state filter: UNPAID, PARTIALLY_PAID, PAID.'),
  state: z.enum(INVOICE_STATES).optional().describe('Invoice state filter: DRAFT, CONFIRMED, VOIDED.'),
};

/** Indicator keys ending in Minor become CZK numbers; counts pass through unchanged. */
const indicatorsInCzk = (indicators: Readonly<Record<string, number>>): Record<string, number> =>
  Object.fromEntries(
    Object.entries(indicators).map(([key, value]) =>
      key.endsWith('Minor') ? [`${key.slice(0, -'Minor'.length)}Czk`, czkFromMinor(value)] : [key, value],
    ),
  );

export const listInvoices = async (input: {
  readonly payment?: (typeof PAYMENT_STATES)[number] | undefined;
  readonly state?: (typeof INVOICE_STATES)[number] | undefined;
}) => {
  const response = await readRecordsOf(VERTICAL.financeBilling, BillingRecordsWire, {});
  const items = response.state.invoices
    .filter((invoice) => input.state === undefined || invoice.businessState === input.state)
    .filter((invoice) => input.payment === undefined || invoice.paymentState === input.payment)
    .map((invoice) => ({
      businessState: invoice.businessState,
      businessStateCs: labelOf(INVOICE_STATE_CS, invoice.businessState),
      counterpartyId: invoice.counterpartyRef.resourceId,
      direction: invoice.direction,
      dueDate: invoice.dueDate,
      issueDate: invoice.issueDate,
      number: invoice.number ?? invoice.documentNumber,
      openCzk: czkFromMinor(invoice.totalMinor - invoice.paidMinor),
      opportunityId: invoice.opportunityId ?? null,
      paidCzk: czkFromMinor(invoice.paidMinor),
      partyId: invoice.partyId ?? null,
      paymentState: invoice.paymentState,
      paymentStateCs: labelOf(PAYMENT_STATE_CS, invoice.paymentState),
      totalCzk: czkFromMinor(invoice.totalMinor),
    }));
  return {
    count: items.length,
    indicators: indicatorsInCzk(response.indicators),
    items,
    referenceDate: response.referenceDate,
  };
};

export const registerBillingTools = (server: McpServer): void => {
  defineTool(
    server,
    'list_invoices',
    'List invoices (faktury) with state, payment state, totals and open amount in CZK, plus receivables and overdue indicators. Optional state and payment filters.',
    listInvoicesInput,
    listInvoices,
  );
};
