import type { SymmyCustomerRows } from '@app/symmy-integration/symmy-internal-contracts';
import { Array as EffectArray } from 'effect';

import type { SymmyCustomersBatchRequest } from './customers-batch-request-contract.ts';

type Customer = SymmyCustomersBatchRequest['customers'][number];
type CustomerRow = SymmyCustomerRows[number];

/** The public customer with every optional list made explicit and the identifiers named as the owner names them. */
const mapCustomer = (customer: Customer): CustomerRow => {
  const shared = {
    addresses: customer.addresses ?? [],
    contacts: customer.contacts ?? [],
    customerId: customer.customerId,
    officialIdentifiers: (customer.officialIdentifiers ?? []).map(({ type, value }) => ({
      identifierType: type,
      value,
    })),
  };
  return customer.kind === 'PERSON'
    ? { ...shared, firstName: customer.firstName, kind: customer.kind, lastName: customer.lastName }
    : { ...shared, businessName: customer.businessName, kind: customer.kind };
};

/**
 * The public customers as the owner admission receives them. The route never sends a contract version, a plan,
 * an evidence reference, a provenance, a time or any scope fact: the route enrollment and the admission derive
 * those, and the selling legal entity comes from the route scope.
 */
export const mapSymmyCustomersBatchRequest = ({ customers }: SymmyCustomersBatchRequest): SymmyCustomerRows =>
  EffectArray.map<SymmyCustomersBatchRequest['customers'], CustomerRow>(mapCustomer)(customers);
