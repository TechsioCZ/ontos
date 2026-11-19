import { Array as EffectArray, Order } from 'effect';

import type { TransactionalMessageType, AudienceSlot } from '../catalog/message-type.ts';
import { resourceRefKey } from '../catalog/vocabulary.ts';
import { contactBindingKey, sameScope } from './original-binding.ts';
import type { OriginalContactBinding, OriginalRecipientBinding, RecipientScope } from './original-binding.ts';
import { RecipientAssessment } from './recipient-assessment.ts';
import type { RecipientAssessmentCase, RecipientSubject, UnresolvedReason } from './recipient-assessment.ts';

/**
 * Binding stage: decide, from what the source evidenced alone, whether one recipient has a single, declared,
 * in-scope original contact. It is pure and never reads a Current contact: whatever fails here is final for this
 * request (`settled`), and whatever passes (`bound`) still needs the Current gate before it may be used.
 */

export interface BoundRecipient {
  readonly contact: OriginalContactBinding;
  readonly kind: 'bound';
  readonly subject: RecipientSubject;
}
export interface SettledRecipient {
  readonly assessment: RecipientAssessmentCase;
  readonly kind: 'settled';
}
export type BindingStage = BoundRecipient | SettledRecipient;

const settled = (assessment: RecipientAssessmentCase): SettledRecipient => ({ assessment, kind: 'settled' });

/** The subject of an ambiguous recipient names the recipient only: no contact is ever picked. */
const withoutContact = ({
  originalContact: _dropped,
  ...binding
}: OriginalRecipientBinding): OriginalRecipientBinding => binding;

type DeclaredContact =
  | { readonly contact: OriginalContactBinding; readonly ok: true }
  | { readonly ok: false; readonly reason: UnresolvedReason };

/** The contact must exist and come from the owner, resource type and evidence kind the slot declares. */
const declaredContact = (slot: AudienceSlot, contact: OriginalContactBinding | undefined): DeclaredContact => {
  if (contact === undefined) {
    return { ok: false, reason: 'ORIGINAL_CONTACT_NOT_EVIDENCED' };
  }
  const { contactOwner, contactResourceType, evidenceKinds } = slot.source;
  if (contact.contactRef.moduleId !== contactOwner || contact.contactRef.resourceType !== contactResourceType) {
    return { ok: false, reason: 'CONTACT_SOURCE_NOT_DECLARED' };
  }
  return evidenceKinds.includes(contact.evidence.kind)
    ? { contact, ok: true }
    : { ok: false, reason: 'EVIDENCE_KIND_NOT_DECLARED' };
};

/**
 * Bind one distinct recipient of one slot, given every binding the source sent for it. The same recipient repeated
 * with the same contact is one recipient; different contacts for it are ambiguous and none is picked.
 */
export const bindRecipient = (
  slot: AudienceSlot,
  scope: RecipientScope,
  group: readonly [OriginalRecipientBinding, ...OriginalRecipientBinding[]],
): BindingStage => {
  const [first] = group;
  const unproven: RecipientSubject = { binding: withoutContact(first), slotKey: slot.slotKey };
  if (new Set(group.map(({ originalContact }) => contactBindingKey(originalContact))).size > 1) {
    return settled(
      RecipientAssessment.RecipientUnresolved({ reason: 'ORIGINAL_CONTACT_AMBIGUOUS', subject: unproven }),
    );
  }
  if (!sameScope(first.scope, scope)) {
    // A contact evidenced in another scope is neither used nor echoed into this request's evidence.
    return settled(RecipientAssessment.RecipientNotAllowed({ reason: 'SCOPE_MISMATCH', subject: unproven }));
  }
  const declared = declaredContact(slot, first.originalContact);
  return declared.ok
    ? { contact: declared.contact, kind: 'bound', subject: { binding: first, slotKey: slot.slotKey } }
    : settled(RecipientAssessment.RecipientUnresolved({ reason: declared.reason, subject: unproven }));
};

const slotsOf = (type: TransactionalMessageType): readonly AudienceSlot[] =>
  type.result.kind === 'MESSAGE_INTENTS' ? type.result.slots : [];

/**
 * One stage result per distinct recipient of every audience slot. Bindings for a role no slot names are ignored, so
 * a source can never add an implicit recipient; the same recipient repeated with the same contact is one recipient;
 * results are ordered by slot and recipient so the input order never matters.
 */
export const bindOriginalRecipients = (
  type: TransactionalMessageType,
  scope: RecipientScope,
  bindings: readonly OriginalRecipientBinding[],
): readonly BindingStage[] =>
  slotsOf(type).flatMap((slot) => {
    const forRole = bindings.filter(({ role }) => role === slot.recipientRole);
    const groups = EffectArray.groupBy(forRole, ({ recipientRef }) => resourceRefKey(recipientRef));
    return Object.entries(groups)
      .toSorted(([a], [b]) => Order.String(a, b))
      .map(([, group]) => bindRecipient(slot, scope, group));
  });
