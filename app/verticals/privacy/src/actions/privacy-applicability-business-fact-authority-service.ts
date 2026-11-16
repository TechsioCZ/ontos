import type { OperationalScope } from '@app/core-runtime';
import type { Crypto } from 'effect';
import { Context, Effect, Layer, Schema } from 'effect';

import { resolveOrganizationIcoBusinessFacts } from '../services/organization-ico-applicability.service.ts';
import { resolveOrganizationProfileIcoBusinessFacts } from '../services/organization-profile-ico-applicability.service.ts';
import { resolveOrganizationBusinessFacts } from '../services/organization-business-applicability.service.ts';
import type { OrganizationBusinessSourceAuthority } from '../services/organization-business-applicability.service.ts';
import { OrganizationProfileIcoOperationSchema } from '../../shared/domain/privacy-applicability.ts';
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
    scope?: OperationalScope,
    sourceAuthority?: OrganizationBusinessSourceAuthority,
  ) => Effect.Effect<
    TrustedPrivacyApplicabilityBusinessFactAuthorityResult,
    PrivacyApplicabilityBusinessFactAuthorityError,
    Crypto.Crypto
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

/** Explicit current nonpersonal contexts resolve their own native facts. Personal eligibility
 * remains independent and cannot inherit a company classification. */
export const PrivacyApplicabilityBusinessFactAuthorityLive = Layer.succeed(
  PrivacyApplicabilityBusinessFactAuthority,
  PrivacyApplicabilityBusinessFactAuthority.of({
    resolve: Effect.fn('Privacy.resolveCurrentNonPersonalAuthority')(
      function* resolve(request, scope, sourceAuthority) {
        if (Schema.is(OrganizationProfileIcoOperationSchema)(request.scope.operation)) {
          return yield* resolveOrganizationProfileIcoBusinessFacts(request, scope);
        }
        if (request.scope.operation === 'party-ico-legacy-inventory.read') {
          return yield* resolveOrganizationIcoBusinessFacts(request, scope);
        }
        return yield* resolveOrganizationBusinessFacts(request, scope, sourceAuthority);
      },
    ),
    resolveEligibility: privacyApplicabilityBusinessFactAuthorityUnavailable.resolveEligibility,
  }),
);
