import type { OwnerAccessFacts } from '@app/core-runtime';
import type {
  CommerceCustomerProfileTarget,
  PriceGroupAuthorizationSubject,
} from '../../shared/domain/price-group-contracts.ts';
import { counterpartyOwnerFacts, retailOwnerFacts } from '../actions/owner-access-facts.ts';

export interface CustomerPriceGroupReadPermissionInput {
  readonly authorizationSubject: PriceGroupAuthorizationSubject;
  readonly profile: CommerceCustomerProfileTarget;
}

/**
 * The owner-local facts of a customer price-group read (O67-Q1, O70): a counterparty subject is
 * checked against that counterparty's own profile grant, a Retail subject against the Retail Portal
 * profile capability. The v2 declaration gates the read itself, and a missing fact denies.
 */
export const customerPriceGroupOwnerFacts = (input: CustomerPriceGroupReadPermissionInput): OwnerAccessFacts =>
  input.authorizationSubject.kind === 'RETAIL'
    ? retailOwnerFacts(input.profile.resourceId, 'retail.profile.read')
    : counterpartyOwnerFacts(input.authorizationSubject.counterpartyRef.resourceId);
