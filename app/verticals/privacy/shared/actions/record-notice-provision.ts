import type { PrivacyNoticeProvisionDraft } from '../domain/privacy-notice-provision.ts';

export {
  PrivacyNoticeProvisionDraftSchema as RecordNoticeProvisionPayloadSchema,
  PrivacyNoticeProvisionSchema as RecordNoticeProvisionResultSchema,
} from '../domain/privacy-notice-provision.ts';
export type RecordNoticeProvisionPayload = PrivacyNoticeProvisionDraft;
