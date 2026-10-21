import { Option } from 'effect';
import { expect, it } from 'effect-rstest';
import {
  customerInvoiceFilterKey,
  decodeCustomerInvoiceSearch,
} from '../../src/routes/[lang]/finance/use-finance-records.ts';

const counterpartyId = '30000000-0000-4000-8000-000000000001';
const tenantId = '10000000-0000-4000-8000-000000000001';
const partyId = '40000000-0000-4000-8000-000000000001';

it('rejects incomplete, malformed or repeated customer query inputs instead of widening to all invoices', () => {
  expect(customerInvoiceFilterKey({ counterpartyId })).toBe('invalid');
  expect(customerInvoiceFilterKey({ counterpartyId, tenantId: 'bad' })).toBe('invalid');
  expect(Option.isNone(decodeCustomerInvoiceSearch({ partyId: [partyId, 'other'] }))).toBe(true);
});

it('keys customer context changes separately while preserving invoice-detail navigation within the same context', () => {
  const first = customerInvoiceFilterKey({ counterpartyId, partyId, tenantId });
  expect(first).toContain('party.registry.counterparty');
  expect(first).not.toContain(partyId);
  expect(
    customerInvoiceFilterKey({ counterpartyId, partyId, resourceId: '70000000-0000-4000-8000-000000000001', tenantId }),
  ).toBe(first);
  expect(customerInvoiceFilterKey({ counterpartyId: 'different-context', tenantId })).not.toBe(first);
  expect(customerInvoiceFilterKey({})).not.toBe(first);
});
