import { Schema } from 'effect';

const Ref = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(300));

export const RecordNoticeProvisionPayloadSchema = Schema.Struct({
  actionRef: Schema.toEncoded(Schema.OptionFromNullOr(Ref)),
  anonymousContextRef: Schema.toEncoded(Schema.OptionFromNullOr(Ref)),
  businessInteractionRef: Schema.toEncoded(Schema.OptionFromNullOr(Ref)),
  channel: Ref,
  channelProof: Schema.optional(Schema.Never),
  claimRef: Ref,
  controllerRef: Ref,
  evidenceRef: Schema.optional(Schema.Never),
  failureReason: Schema.optional(Schema.Never),
  noticeVersionRef: Ref,
  outcome: Schema.optional(Schema.Never),
  privacySubjectRef: Schema.toEncoded(Schema.OptionFromNullOr(Ref)),
  processingPurposeRef: Ref,
  processingScopeRef: Ref,
  providedLanguage: Ref,
  provisionedAt: Schema.optional(Schema.Never),
  recordedAt: Schema.optional(Schema.Never),
  supersedesProvisionRef: Schema.optional(Schema.Never),
});
export type RecordNoticeProvisionPayload = typeof RecordNoticeProvisionPayloadSchema.Type;
export { PrivacyNoticeProvisionSchema as RecordNoticeProvisionResultSchema } from '../domain/privacy-notice-provision.ts';
