import { OntosModuleIdSchema } from '@app/core-runtime/modules/manifest';
import { Schema } from 'effect';

import { DocumentPolicySchema } from '../documents/document-policy.ts';
import { AudiencePolicySchema } from './audience.ts';
import {
  ApprovedRuleKeySchema,
  AudienceSlotKeySchema,
  CommunicationPurposeKeySchema,
  CommunicationResourceTypeSchema,
  MessageTypeIdSchema,
  MessageTypeStatusSchema,
  PrivacyPurposeKeySchema,
  RecipientRoleSchema,
  RequirednessSchema,
  RevisionSchema,
  SourceOnboardingSchema,
  SourceStateKeySchema,
} from './vocabulary.ts';

/** Closed set of ways a source owner can evidence the contact that was valid at the original event (#1395, 1B). */
export const OriginalContactEvidenceKindSchema = Schema.Literals([
  'HISTORICAL_SNAPSHOT',
  'VERSIONED_SNAPSHOT',
  'AUTHORITATIVE_REFERENCE',
]);

/**
 * Where the original recipient's contact comes from at event time, declared per audience slot: the owner module and
 * resource type of the contact, and which evidence kinds that owner is approved to supply. Evidence outside the
 * declaration is never accepted, and a missing contact is never replaced by a Current one.
 */
export const OriginalContactSourceSchema = Schema.Struct({
  contactOwner: OntosModuleIdSchema,
  contactResourceType: CommunicationResourceTypeSchema,
  evidenceKinds: Schema.NonEmptyArray(OriginalContactEvidenceKindSchema),
});

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
  /** Where the original recipient's contact comes from at event time (#1395). */
  source: OriginalContactSourceSchema,
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
 * The approved recovery rule of a type (#1403, PO 2A): whether Communications may AUTOMATICALLY begin another attempt of
 * the SAME Message Intent after a PROVEN non-acceptance of the previous one. It is platform-owned data of the approved type
 * and has no tenant override. `NONE` is the default: automatic action halts and records why. The only approved variant
 * carries the owner's own per-flow limit (`maxAttempts`, the total number of submitted attempts the owner approved): the
 * limit comes from the approved catalog entry together with the step-22 handoff, and no code, default or fallback ever
 * supplies one. A rule without a limit cannot be expressed, so there is no unlimited automatic recovery.
 */
export const RecoveryPolicySchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('NONE') }),
  Schema.Struct({
    kind: Schema.Literal('RETRY_ON_PROVEN_NON_ACCEPTANCE'),
    maxAttempts: RevisionSchema,
  }),
]);
export type RecoveryPolicy = typeof RecoveryPolicySchema.Type;

/**
 * Whether the SOURCE OWNER approved an Explicit Resend of this type (#1403, PO 1A). Per type and platform-owned; a tenant
 * switch, an operator permission or access to the history never grants it. `NOT_ALLOWED` is the default.
 */
export const ResendPolicySchema = Schema.Literals(['NOT_ALLOWED', 'SOURCE_APPROVED']);
export type ResendPolicy = typeof ResendPolicySchema.Type;

/**
 * Transactional Message Type: the approved purpose and policy behind one kind of message. It names meaning, owner,
 * eligibility and audience; it carries no template, language, copy, recipient address or secret, and it never
 * claims transport success.
 */
export const TransactionalMessageTypeSchema = Schema.Struct({
  /** Individual evaluation by default; an indivisible group only as an explicitly approved per-type exception. */
  audience: AudiencePolicySchema,
  currentness: CurrentnessSchema,
  /**
   * Whether and how the type may carry a document (#1409). Absent means NO documents: a link is allowed only for a type that
   * says so, and an attachment only with its own explicit approval. Adding the policy changes no existing type.
   */
  documents: Schema.optionalKey(DocumentPolicySchema),
  eligibleSourceStates: Schema.NonEmptyArray(SourceStateKeySchema),
  /** Stable plain-language statement of what the type means; documentation, not message copy. */
  meaning: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300)),
  onboarding: SourceOnboardingSchema,
  privacyPurposeRefs: Schema.Array(PrivacyPurposeKeySchema),
  purpose: CommunicationPurposeKeySchema,
  /** The approved automatic recovery rule; absent means `NONE`. See `recoveryPolicyOf`. */
  recovery: Schema.optionalKey(RecoveryPolicySchema),
  requiredness: RequirednessSchema,
  /** Whether the source owner approved an Explicit Resend of this type; absent means `NOT_ALLOWED`. See `resendPolicyOf`. */
  resend: Schema.optionalKey(ResendPolicySchema),
  result: ApprovedResultSchema,
  /** Revision of this approved rule; a decision records it so a later catalog change cannot rewrite it. */
  revision: RevisionSchema,
  sourceOwner: OntosModuleIdSchema,
  status: MessageTypeStatusSchema,
  typeId: MessageTypeIdSchema,
});
export type TransactionalMessageType = typeof TransactionalMessageTypeSchema.Type;

const NO_RECOVERY: RecoveryPolicy = { kind: 'NONE' };

/** The recovery rule of an approved type: absent is `NONE`, so a type that declares nothing never recovers on its own. */
export const recoveryPolicyOf = (type: Pick<TransactionalMessageType, 'recovery'>): RecoveryPolicy =>
  type.recovery ?? NO_RECOVERY;

/** The resend approval of an approved type: absent is `NOT_ALLOWED`, so a type that declares nothing has no resend. */
export const resendPolicyOf = (type: Pick<TransactionalMessageType, 'resend'>): ResendPolicy =>
  type.resend ?? 'NOT_ALLOWED';
