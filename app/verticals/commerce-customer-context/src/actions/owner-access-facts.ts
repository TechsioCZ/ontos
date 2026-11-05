import type { OwnerAccessFacts } from '@app/core-runtime';

/**
 * The owner-local facts ccc hands to its own authorization overlay (O67-Q1, O70). They name the
 * counterparty or Retail Portal profile whose grant the owner rule checks; they carry no authority
 * of their own, never reach the decision engine, and a missing fact makes the overlay deny.
 */

/** The counterparty whose grant the owner rule checks, plus its Storefront when the check is scoped. */
export const counterpartyOwnerFacts = (counterpartyId: string, storefrontId?: string | null): OwnerAccessFacts =>
  storefrontId === undefined || storefrontId === null ? { counterpartyId } : { counterpartyId, storefrontId };

/** The Retail Portal profile and the retail capability code the owner rule checks. */
export const retailOwnerFacts = (retailProfileId: string, retailPermission: string): OwnerAccessFacts => ({
  retailPermission,
  retailProfileId,
});
