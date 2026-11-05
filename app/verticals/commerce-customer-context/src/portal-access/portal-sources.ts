/*
 * The owner grants a portal assignment stands for, as keys this module never gives another grant. Core names
 * one assignment incarnation by its source, so replaying a source finds the assignment it wrote, and ending a
 * source ends exactly that assignment (`@app/core-runtime/access/portal`).
 */

/** One activation of a Retail Portal Profile Binding: a BIND, or a RECOVER of a revoked binding. */
export const retailPortalBindingActivationSource = (bindingId: string, revision: number): string =>
  `commerce.customer-context.retail-portal-binding:${bindingId}:${String(revision)}`;

/** One Counterparty Commerce Access grant row: it is ACTIVE once and REVOKED for good. */
export const counterpartyAccessGrantSource = (grantId: string): string =>
  `commerce.customer-context.counterparty-access-grant:${grantId}`;

/** One redeemed claim proof of one invitation: the recipient may claim until the claim consumes it. */
export const counterpartyInvitationRedemptionSource = (invitationId: string, proofReference: string): string =>
  `commerce.customer-context.counterparty-invitation:${invitationId}:${proofReference}`;
