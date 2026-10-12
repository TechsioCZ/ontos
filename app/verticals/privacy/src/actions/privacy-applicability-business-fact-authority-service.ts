import { Context, Effect, Layer } from 'effect';

import { PrivacyApplicabilityBusinessFactAuthorityError } from './privacy-applicability-business-fact-authority.ts';
import type {
  PrivacyApplicabilityEligibilityAuthorityRequest,
  PrivacyApplicabilityBusinessFactAuthorityRequest,
  TrustedPrivacyApplicabilityEligibilityAuthorityResult,
  TrustedPrivacyApplicabilityBusinessFactAuthorityResult,
} from './privacy-applicability-business-fact-authority.ts';

export interface PrivacyApplicabilityBusinessFactAuthorityService {
  readonly resolve: (
    request: PrivacyApplicabilityBusinessFactAuthorityRequest,
  ) => Effect.Effect<
    TrustedPrivacyApplicabilityBusinessFactAuthorityResult,
    PrivacyApplicabilityBusinessFactAuthorityError
  >;
  readonly resolveEligibility: (
    request: PrivacyApplicabilityEligibilityAuthorityRequest,
  ) => Effect.Effect<
    TrustedPrivacyApplicabilityEligibilityAuthorityResult,
    PrivacyApplicabilityBusinessFactAuthorityError
  >;
}

export class PrivacyApplicabilityBusinessFactAuthority extends Context.Service<
  PrivacyApplicabilityBusinessFactAuthority,
  PrivacyApplicabilityBusinessFactAuthorityService
>()(
  '@app/privacy/actions/privacy-applicability-business-fact-authority-service/PrivacyApplicabilityBusinessFactAuthority',
) {}

export const privacyApplicabilityBusinessFactAuthorityUnavailable: PrivacyApplicabilityBusinessFactAuthorityService = {
  resolve: () =>
    Effect.fail(
      new PrivacyApplicabilityBusinessFactAuthorityError({
        code: 'AUTHORITY_UNAVAILABLE',
        reason: 'Applicability business-fact authority is not configured',
      }),
    ),
  resolveEligibility: () =>
    Effect.fail(
      new PrivacyApplicabilityBusinessFactAuthorityError({
        code: 'AUTHORITY_UNAVAILABLE',
        reason: 'Applicability business-fact authority is not configured',
      }),
    ),
};

export const PrivacyApplicabilityBusinessFactAuthorityUnavailableLive = Layer.succeed(
  PrivacyApplicabilityBusinessFactAuthority,
  privacyApplicabilityBusinessFactAuthorityUnavailable,
);
