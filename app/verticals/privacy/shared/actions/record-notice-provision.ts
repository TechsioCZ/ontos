/* eslint-disable effect-native/no-nullable-schema-field -- The public Notice delivery request carries explicit subject-context absence. expires: 2027-03-31. */
import { Schema } from 'effect';

const Ref = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(300));

export const RecordNoticeProvisionPayloadSchema = Schema.Struct({
  actionRef: Schema.NullOr(Ref),
  anonymousContextRef: Schema.NullOr(Ref),
  businessInteractionRef: Schema.NullOr(Ref),
  channel: Ref,
  channelProof: Schema.optional(Schema.Never),
  claimRef: Ref,
  controllerRef: Ref,
  evidenceRef: Schema.optional(Schema.Never),
  failureReason: Schema.optional(Schema.Never),
  noticeVersionRef: Ref,
  outcome: Schema.optional(Schema.Never),
  privacySubjectRef: Schema.NullOr(Ref),
  processingPurposeRef: Ref,
  processingScopeRef: Ref,
  providedLanguage: Ref,
  provisionedAt: Schema.optional(Schema.Never),
  recordedAt: Schema.optional(Schema.Never),
  supersedesProvisionRef: Schema.optional(Schema.Never),
});
export type RecordNoticeProvisionPayload = typeof RecordNoticeProvisionPayloadSchema.Type;
export { PrivacyNoticeProvisionSchema as RecordNoticeProvisionResultSchema } from '../domain/privacy-notice-provision.ts';
