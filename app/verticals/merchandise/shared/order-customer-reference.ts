import type { CounterpartyReadResponse } from '@app/party-registry/api';
import type { MerchandiseCommand } from './actions/apply-command.ts';

type Link = Extract<MerchandiseCommand, { readonly _tag: 'LinkOrderCustomer' }>;

/** A native CUSTOMER of this company only; the order cannot invent a Party or a role. */
export const orderCustomerReferenceEligible = (
  link: Link,
  record: CounterpartyReadResponse,
  scope: { readonly legalEntityId: string; readonly tenantId: string },
  now: string,
): boolean =>
  link.partyRef.tenantId === scope.tenantId &&
  link.counterpartyRef.tenantId === scope.tenantId &&
  record.counterpartyRef.resourceId === link.counterpartyRef.resourceId &&
  record.counterpartyRef.tenantId === scope.tenantId &&
  record.legalEntityRef.tenantId === scope.tenantId &&
  record.legalEntityRef.resourceId === scope.legalEntityId &&
  !record.party.archived &&
  record.party.canonicalPartyRef.resourceId === link.partyRef.resourceId &&
  record.party.canonicalPartyRef.tenantId === scope.tenantId &&
  record.currentRoles.some(
    (role) =>
      role.roleType === 'CUSTOMER' &&
      role.state === 'ACTIVE' &&
      role.validFrom <= now &&
      (role.validTo === null || role.validTo > now),
  );
