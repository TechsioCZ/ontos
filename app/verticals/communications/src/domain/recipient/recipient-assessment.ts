import { Data, Schema } from 'effect';

import type { AudienceSlotKey } from '../catalog/vocabulary.ts';
import type { OriginalRecipientBinding, ProtectedEndpoint } from './original-binding.ts';

/**
 * Recipient outcomes in business meaning (#1395). They answer one question for ONE recipient: may this Message
 * Recipient and this Original Delivery Endpoint be used now? They never name a replacement contact, never claim
 * identity verification, and never say anything about transport or delivery. Privacy is a separate fact.
 */

/**
 * Why the original recipient may not be used, as a current and owner-decided fact:
 * - SCOPE_MISMATCH: the binding was evidenced in another Tenant, Legal Entity, profile, Counterparty or Storefront;
 * - RECIPIENT_IDENTITY_CHANGED: the intent, binding and request no longer name the same recipient and slot;
 * - ENDPOINT_IDENTITY_CHANGED: the owner answered for another contact or revision than the original one;
 * - SOURCE_NO_LONGER_VALID: the source occurrence is no longer valid for this communication;
 * - ORIGINAL_ENDPOINT_UNUSABLE: the original endpoint ended, was revoked or can no longer be used safely;
 * - OWNER_BINDING_INVALID: an Auth or invitation owner binding is no longer valid (revoked, expired, claimed);
 * - PERMISSION_ABSENT, VISIBILITY_DENIED, OWNERSHIP_SCOPE_MISMATCH: Current permission, visibility or ownership.
 */
export const GateUnusableReasonSchema = Schema.Literals([
  'SOURCE_NO_LONGER_VALID',
  'ORIGINAL_ENDPOINT_UNUSABLE',
  'OWNER_BINDING_INVALID',
  'PERMISSION_ABSENT',
  'VISIBILITY_DENIED',
  'OWNERSHIP_SCOPE_MISMATCH',
]);
export type GateUnusableReason = typeof GateUnusableReasonSchema.Type;

export const NotAllowedReasonSchema = Schema.Literals([
  'SCOPE_MISMATCH',
  'RECIPIENT_IDENTITY_CHANGED',
  'ENDPOINT_IDENTITY_CHANGED',
  ...GateUnusableReasonSchema.literals,
]);
export type NotAllowedReason = typeof NotAllowedReasonSchema.Type;

/**
 * Why the original recipient or endpoint cannot be determined. It is never reconstructed from a Current profile:
 * - ORIGINAL_CONTACT_NOT_EVIDENCED: the source supplied no contact valid at the event;
 * - CONTACT_SOURCE_NOT_DECLARED: the contact comes from an owner or resource type the approved type does not declare;
 * - EVIDENCE_KIND_NOT_DECLARED: the evidence kind is not one the approved type accepts for this audience slot;
 * - ORIGINAL_CONTACT_AMBIGUOUS: the same recipient came with different original contacts, and none is picked.
 */
export const UnresolvedReasonSchema = Schema.Literals([
  'ORIGINAL_CONTACT_NOT_EVIDENCED',
  'CONTACT_SOURCE_NOT_DECLARED',
  'EVIDENCE_KIND_NOT_DECLARED',
  'ORIGINAL_CONTACT_AMBIGUOUS',
]);
export type UnresolvedReason = typeof UnresolvedReasonSchema.Type;

/** Which mandatory authority could not answer. Fail-closed: no stale permission replaces its answer. */
export const UnavailableAuthoritySchema = Schema.Literals(['SOURCE_OWNER', 'PERMISSION', 'OWNERSHIP_VISIBILITY']);
export type UnavailableAuthority = typeof UnavailableAuthoritySchema.Type;

/** The recipient and audience slot one assessment is about. `binding` never carries an unproven contact. */
export interface RecipientSubject {
  readonly binding: OriginalRecipientBinding;
  readonly slotKey: AudienceSlotKey;
}

export type RecipientAssessmentCase = Data.TaggedEnum<{
  /** The original recipient and endpoint are usable now. `endpoint` is protected and never stored. */
  RecipientAllowed: { readonly endpoint: ProtectedEndpoint; readonly subject: RecipientSubject };
  /** A proven fact says this original recipient or endpoint may not be used. */
  RecipientNotAllowed: { readonly reason: NotAllowedReason; readonly subject: RecipientSubject };
  /** The original recipient or endpoint cannot be determined from what the source evidenced. */
  RecipientUnresolved: { readonly reason: UnresolvedReason; readonly subject: RecipientSubject };
  /** A mandatory authority could not answer, so nothing is proven either way. Distinct from a prohibition. */
  SourceUnavailable: { readonly authority: UnavailableAuthority; readonly subject: RecipientSubject };
}>;
export const RecipientAssessment = Data.taggedEnum<RecipientAssessmentCase>();
