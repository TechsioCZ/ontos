import { Effect } from 'effect';
import { defineMicroverticalPolicy, denyPolicy } from '@app/core-runtime';
import type { PrivacyEligibilityConsumerResponse } from '../../shared/domain/privacy-eligibility-consumer-contract.ts';
import { privacyEligibilityAllowsConsumerOperation } from '../../shared/domain/privacy-eligibility-consumer-contract.ts';

export const processingEligibilityPolicy = defineMicroverticalPolicy<
  PrivacyEligibilityConsumerResponse,
  'privacy.core'
>({
  evaluate: ({ payload }) =>
    privacyEligibilityAllowsConsumerOperation(payload)
      ? Effect.void
      : Effect.fail(
          denyPolicy('processing_eligibility_not_allowed', 'Processing Eligibility did not allow this exact operation'),
        ),
  owningModuleKey: 'privacy.core',
  policyKey: 'privacy.core.processing-eligibility.v1',
});
