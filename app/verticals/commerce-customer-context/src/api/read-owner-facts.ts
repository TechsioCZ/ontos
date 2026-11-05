import type { OwnerAccessFacts } from '@app/core-runtime';
import { counterpartyOwnerFacts, retailOwnerFacts } from '../actions/owner-access-facts.ts';
import type { AddressBookProfile } from '../../shared/domain/address-book.ts';
import type { CounterpartyPermissionScope } from '../../shared/domain/access-contract.ts';
import type { CommerceCustomerProfileSubject } from '../../shared/domain/profile-contracts.ts';
import type { CustomerHistorySubject } from '../../shared/domain/record-visibility-contracts.ts';
import type { PaymentTermsAuthorizationSubject } from '../../shared/domain/payment-term-contracts.ts';
/**
 * The owner-local facts ccc reads publish for their owner rule (O67-Q1, O70). A read that a
 * counterparty or a Retail Portal profile governs names that record, so the owner overlay can check
 * the record's own Postgres grant; a guest or scope-wide read declares no such record. The facts
 * carry no authority, never reach the engine, and a missing fact makes the overlay deny.
 */

interface CounterpartyRefLike {
  readonly resourceId: string;
}
interface ProfileRefLike {
  readonly resourceId: string;
}

/** The Retail capability a Retail-scoped ccc read checks against the profile's own durable state. */
const RETAIL_PROFILE_READ = 'retail.profile.read';

/** A subject whose retail branch is a profile and whose counterparty branch names its counterparty. */
type CounterpartyOrRetailSubject =
  | { readonly kind: 'RETAIL'; readonly profileRef: ProfileRefLike }
  | { readonly kind: 'RETAIL_PROFILE'; readonly profileRef: ProfileRefLike }
  | {
      readonly counterpartyRef: CounterpartyRefLike;
      readonly kind: 'COUNTERPARTY';
      readonly profileRef: ProfileRefLike;
    };

/** The counterparty a counterparty-governed read acts on. */
export const counterpartyRefOwnerFacts = (input: { readonly counterpartyRef: CounterpartyRefLike }): OwnerAccessFacts =>
  counterpartyOwnerFacts(input.counterpartyRef.resourceId);

/** The counterparty a Storefront-scoped access-management read acts on, with that Storefront. */
export const counterpartyScopeOwnerFacts = (input: {
  readonly counterpartyRef: CounterpartyRefLike;
  readonly scope: CounterpartyPermissionScope;
}): OwnerAccessFacts =>
  counterpartyOwnerFacts(
    input.counterpartyRef.resourceId,
    input.scope.kind === 'storefront' ? input.scope.storefrontKey : undefined,
  );

/** The counterparty a purchase-limit read acts on in its named Storefront. */
export const counterpartyStorefrontOwnerFacts = (input: {
  readonly counterpartyRef: CounterpartyRefLike;
  readonly storefrontId: string;
}): OwnerAccessFacts => counterpartyOwnerFacts(input.counterpartyRef.resourceId, input.storefrontId);

/** The Retail profile or Counterparty a customer-profile read is about (O67-Q1, O70). */
export const customerProfileSubjectOwnerFacts = (input: {
  readonly authorizationSubject: CommerceCustomerProfileSubject;
  readonly profileRef: ProfileRefLike;
}): OwnerAccessFacts =>
  input.authorizationSubject.kind === 'RETAIL'
    ? retailOwnerFacts(input.profileRef.resourceId, RETAIL_PROFILE_READ)
    : counterpartyOwnerFacts(input.authorizationSubject.counterpartyRef.resourceId);

/** The Retail profile or Counterparty a restriction read is about. */
export const restrictionSubjectOwnerFacts = (input: {
  readonly subject: CounterpartyOrRetailSubject;
}): OwnerAccessFacts =>
  input.subject.kind === 'COUNTERPARTY'
    ? counterpartyOwnerFacts(input.subject.counterpartyRef.resourceId)
    : retailOwnerFacts(input.subject.profileRef.resourceId, RETAIL_PROFILE_READ);

/** The Retail profile whose own durable authorization state a retail-access read asks about. */
export const retailAccessDecisionOwnerFacts = (input: {
  readonly profileRef: ProfileRefLike;
  readonly requiredPermission: string;
}): OwnerAccessFacts => retailOwnerFacts(input.profileRef.resourceId, input.requiredPermission);

/** The Retail profile a Retail-only read acts on, with the Retail capability it needs. */
export const retailProfileOwnerFacts = (
  input: { readonly profileRef: ProfileRefLike },
  retailPermission: string,
): OwnerAccessFacts => retailOwnerFacts(input.profileRef.resourceId, retailPermission);

/** A payment-terms subject: a Retail profile, or the Counterparty its profile belongs to. */
export const paymentTermsSubjectOwnerFacts = (input: {
  readonly authorizationSubject: PaymentTermsAuthorizationSubject;
  readonly profileRef: ProfileRefLike;
}): OwnerAccessFacts =>
  input.authorizationSubject.kind === 'COUNTERPARTY'
    ? counterpartyOwnerFacts(input.authorizationSubject.counterpartyRef.resourceId)
    : retailOwnerFacts(input.profileRef.resourceId, RETAIL_PROFILE_READ);

/**
 * A history subject: the Retail profile or the Counterparty whose own history grant a
 * `historical_read` needs. `retailPermission` differs per read (`retail.history.read` for the order
 * history and archive, `retail.repeat_order` for Repeat Order preparation), and the Counterparty
 * branch is the same owner record either way.
 */
const historySubjectOwnerFacts = (input: {
  readonly retailPermission: string;
  readonly subject: CustomerHistorySubject;
}): OwnerAccessFacts =>
  input.subject.kind === 'RETAIL_PROFILE'
    ? retailOwnerFacts(input.subject.profileRef.resourceId, input.retailPermission)
    : counterpartyOwnerFacts(input.subject.counterpartyRef.resourceId);

/** The owner facts of the customer-facing archive/order-history reads (O67-Q1, O70). */
export const customerHistorySubjectOwnerFacts = (input: {
  readonly subject: CustomerHistorySubject;
}): OwnerAccessFacts => historySubjectOwnerFacts({ retailPermission: 'retail.history.read', subject: input.subject });

/** The owner facts of Repeat Order preparation: a Retail profile or the source Counterparty. */
export const repeatOrderSubjectOwnerFacts = (input: { readonly subject: CustomerHistorySubject }): OwnerAccessFacts =>
  historySubjectOwnerFacts({ retailPermission: 'retail.repeat_order', subject: input.subject });

/** The owner facts of the saved-address reads: the profile's own address-book grant. */
export const addressBookProfileOwnerFacts = (input: { readonly profile: AddressBookProfile }): OwnerAccessFacts =>
  input.profile.kind === 'COUNTERPARTY'
    ? counterpartyOwnerFacts(input.profile.counterpartyRef.resourceId)
    : retailOwnerFacts(input.profile.profileRef.resourceId, 'retail.address_book.use');
