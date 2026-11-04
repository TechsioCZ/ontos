// Owner and consumer calls over the generated governed lease-invoices client.
import { executeLeaseInvoices } from './lease-invoices-client.ts';
import type { LeaseInvoicesClientOptions } from './lease-invoices-client.ts';
import type { LeaseInvoicesRequest } from '../../shared/apis/lease-invoices.ts';

// Consumers reach the generated governed client and its exact lease-invoice page contract through one package export.
export { executeLeaseInvoices, executeLeaseInvoicesWithAuthorization } from './lease-invoices-client.ts';
export { LEASE_INVOICES_PAGE_LIMIT_DEFAULT, LEASE_INVOICES_PAGE_LIMIT_MAX } from '../../shared/apis/lease-invoices.ts';
export type { LeaseInvoicesRequest, LeaseInvoicesResponse } from '../../shared/apis/lease-invoices.ts';

/** Requests one exact lease-invoice page; continue with `nextCursor` until it is absent. */
export const listLeaseInvoices = (
  request: LeaseInvoicesRequest,
  requestCorrelation = 'finance-billing.lease-invoices',
  options: LeaseInvoicesClientOptions = {},
) => executeLeaseInvoices(request, requestCorrelation, options);
