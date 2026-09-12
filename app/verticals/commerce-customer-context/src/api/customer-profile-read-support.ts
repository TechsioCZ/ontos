import { ReadHandlerNotFound } from '@app/core-runtime';
import type { CommerceCustomerProfileSubject } from '../../shared/domain/profile-contracts.ts';

export const customerProfileNotFound = () =>
  new ReadHandlerNotFound({
    code: 'read_handler_not_found',
    reason: 'The Customer Profile does not exist in the trusted Tenant',
  });

export const sameCommerceCustomerProfileSubject = (
  durable: CommerceCustomerProfileSubject,
  requested: CommerceCustomerProfileSubject,
): boolean => {
  if (durable.kind !== requested.kind) {
    return false;
  }
  return durable.kind === 'RETAIL' && requested.kind === 'RETAIL'
    ? durable.partyRef.resourceId === requested.partyRef.resourceId &&
        durable.partyRef.tenantId === requested.partyRef.tenantId &&
        durable.sellingLegalEntityRef.resourceId === requested.sellingLegalEntityRef.resourceId &&
        durable.sellingLegalEntityRef.tenantId === requested.sellingLegalEntityRef.tenantId
    : durable.kind === 'COUNTERPARTY' &&
        requested.kind === 'COUNTERPARTY' &&
        durable.counterpartyRef.resourceId === requested.counterpartyRef.resourceId &&
        durable.counterpartyRef.tenantId === requested.counterpartyRef.tenantId;
};
