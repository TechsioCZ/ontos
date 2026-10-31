// Owner and consumer calls over the generated governed records client.
import { Effect } from 'effect';
import type { RecordsRequest } from '../../shared/apis/records.ts';
import { executeRecords } from './records-client.ts';
import type { RecordsClientOptions } from './records-client.ts';

// Consumers reach the generated governed client and its invoice projection through one package export.
export { executeRecords, executeRecordsWithAuthorization } from './records-client.ts';

/** Invoice list filters; every filter is optional and filters combine with AND. */
export type InvoiceListFilters = Pick<RecordsRequest, 'opportunityId' | 'partyId' | 'propertyId' | 'resourceId'>;

/** Lists invoices (with stored lines, totals and VAT recap) visible in the caller's legal-entity scope. */
export const listInvoices = (
  filters: InvoiceListFilters = {},
  requestCorrelation = 'finance-billing.invoices',
  options: RecordsClientOptions = {},
) => executeRecords(filters, requestCorrelation, options).pipe(Effect.map((response) => response.state.invoices));
