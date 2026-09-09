/* oxlint-disable github/filenames-match-regex -- Codesmith owns this exact action/topic-derived filename; remove-when: Codesmith emits lint-compatible wrapper filenames. */
import type { OutboxMessage } from '@app/core-runtime';
import {
  outboxProducerModuleKey,
  outboxTopic,
} from '@app/commerce-fx/outbox/commerce-fx-manual-commercial-rate-policy-changed-v1';
import type { OutboxPayload } from '@app/commerce-fx/outbox/commerce-fx-manual-commercial-rate-policy-changed-v1';

export { OutboxPayloadSchema as ChangeManualCommercialRatePolicyCommerceFxManualCommercialRatePolicyChangedV1OutboxPayloadSchema } from '@app/commerce-fx/outbox/commerce-fx-manual-commercial-rate-policy-changed-v1';
export type ChangeManualCommercialRatePolicyCommerceFxManualCommercialRatePolicyChangedV1OutboxPayload =
  OutboxPayload;
export const ChangeManualCommercialRatePolicyCommerceFxManualCommercialRatePolicyChangedV1OutboxProducerModuleKey =
  outboxProducerModuleKey;
export const ChangeManualCommercialRatePolicyCommerceFxManualCommercialRatePolicyChangedV1OutboxTopic =
  outboxTopic;

export const createChangeManualCommercialRatePolicyCommerceFxManualCommercialRatePolicyChangedV1OutboxMessage =
  (payload: OutboxPayload): OutboxMessage => ({
    payloadJson: payload,
    producerModuleKey:
      ChangeManualCommercialRatePolicyCommerceFxManualCommercialRatePolicyChangedV1OutboxProducerModuleKey,
    topic: ChangeManualCommercialRatePolicyCommerceFxManualCommercialRatePolicyChangedV1OutboxTopic,
  });
