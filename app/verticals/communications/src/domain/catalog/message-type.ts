import { OntosModuleIdSchema } from '@app/core-runtime/modules/manifest';
import { Schema } from 'effect';

import {
  ApprovedRuleKeySchema,
  AudienceSlotKeySchema,
  CommunicationPurposeKeySchema,
  MessageTypeIdSchema,
  MessageTypeStatusSchema,
  PrivacyPurposeKeySchema,
  RecipientRoleSchema,
  RequirednessSchema,
  RevisionSchema,
  SourceOnboardingSchema,
  SourceStateKeySchema,
} from './vocabulary.ts';

/**
 * One approved audience slot of a type. Every slot yields its own Message Intent candidate(s) with their own
 * recipient decision; a role no slot names can never receive a message, so there is no implicit broadcast.
 * `EXACTLY_ONE` needs one unambiguous recipient for the role; `EACH_MATCHING` is the approved N-recipient policy
 * and creates one candidate per distinct recipient the recipient algorithm (d21-03) supplies for that role.
 */
export const AudienceSlotSchema = Schema.Struct({
  cardinality: Schema.Literals(['EXACTLY_ONE', 'EACH_MATCHING']),
  recipientRole: RecipientRoleSchema,
  slotKey: AudienceSlotKeySchema,
});
export type AudienceSlot = typeof AudienceSlotSchema.Type;

const slotKeysAreUnique = Schema.makeFilter((slots: readonly AudienceSlot[]) =>
  new Set(slots.map((slot) => slot.slotKey)).size === slots.length ? undefined : 'audience slot keys must be unique',
);

/** The approved communication result of a type: an explicit zero-message rule or 1..N audience slots. */
export const ApprovedResultSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('NO_MESSAGE'), ruleKey: ApprovedRuleKeySchema }),
  Schema.Struct({
    kind: Schema.Literal('MESSAGE_INTENTS'),
    slots: Schema.NonEmptyArray(AudienceSlotSchema).check(slotKeysAreUnique),
  }),
]);

/**
 * How the type goes stale. A superseded source revision always stops a type that requires the latest revision;
 * a source state outside `eligibleSourceStates` always stops every type.
 */
export const CurrentnessSchema = Schema.Struct({ requireLatestSourceRevision: Schema.Boolean });

/**
 * Transactional Message Type: the approved purpose and policy behind one kind of message. It names meaning, owner,
 * eligibility and audience; it carries no template, language, copy, recipient address or secret, and it never
 * claims transport success.
 */
export const TransactionalMessageTypeSchema = Schema.Struct({
  currentness: CurrentnessSchema,
  eligibleSourceStates: Schema.NonEmptyArray(SourceStateKeySchema),
  /** Stable plain-language statement of what the type means; documentation, not message copy. */
  meaning: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300)),
  onboarding: SourceOnboardingSchema,
  privacyPurposeRefs: Schema.Array(PrivacyPurposeKeySchema),
  purpose: CommunicationPurposeKeySchema,
  requiredness: RequirednessSchema,
  result: ApprovedResultSchema,
  /** Revision of this approved rule; a decision records it so a later catalog change cannot rewrite it. */
  revision: RevisionSchema,
  sourceOwner: OntosModuleIdSchema,
  status: MessageTypeStatusSchema,
  typeId: MessageTypeIdSchema,
});
export type TransactionalMessageType = typeof TransactionalMessageTypeSchema.Type;
