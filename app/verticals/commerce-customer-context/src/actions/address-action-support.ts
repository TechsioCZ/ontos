import type { OwnerAccessFacts } from '@app/core-runtime';
import type { AddressBookProfile } from '../../shared/domain/address-book.ts';
import { counterpartyOwnerFacts, retailOwnerFacts } from './owner-access-facts.ts';

/**
 * The address-book owner rule target: a counterparty profile is checked against that counterparty's
 * own grant, a retail profile against the retail address-book capability (O67-Q1, O70).
 */
export const manageAddressOwnerFacts = (payload: { readonly profile: AddressBookProfile }): OwnerAccessFacts =>
  payload.profile.kind === 'COUNTERPARTY'
    ? counterpartyOwnerFacts(payload.profile.counterpartyRef.resourceId)
    : retailOwnerFacts(payload.profile.profileRef.resourceId, 'retail.address_book.manage');
