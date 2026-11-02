// Public contract adapted from the generated acknowledge-privacy-notice Action.
import { Schema } from 'effect';
import {
  PrivacyNoticeAcknowledgementRefSchema,
  PrivacyNoticeVersionIdSchema,
  PrivacyNoticePresentationReceiptSchema,
} from '../resources/privacy-notice-acknowledgement.ts';
import { PrivacyNoticeIsoTimestampSchema } from '../domain/privacy-notice-version.ts';

export const AcknowledgePrivacyNoticePayloadSchema = Schema.Struct({
  acknowledged: Schema.Literal(true),
  channelProof: Schema.optional(Schema.Never),
  evidenceRef: Schema.optional(Schema.Never),
  outcome: Schema.optional(Schema.Never),
  presentationReceipt: PrivacyNoticePresentationReceiptSchema,
  recordedAt: Schema.optional(Schema.Never),
});
export type AcknowledgePrivacyNoticePayload = typeof AcknowledgePrivacyNoticePayloadSchema.Type;

export const AcknowledgePrivacyNoticeResultSchema = Schema.Struct({
  acknowledgedAt: PrivacyNoticeIsoTimestampSchema,
  acknowledgementRef: PrivacyNoticeAcknowledgementRefSchema,
  noticeVersionId: PrivacyNoticeVersionIdSchema,
});
export type AcknowledgePrivacyNoticeResult = typeof AcknowledgePrivacyNoticeResultSchema.Type;
