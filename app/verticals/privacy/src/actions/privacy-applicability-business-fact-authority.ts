import { Schema } from 'effect';

import {
  PrivacyApplicabilityEligibilityAuthorityResultSchema,
  PrivacyApplicabilityAuthoritySchema,
  PrivacyApplicabilityScopeIntentSchema,
  PrivacyApplicabilityScopeSchema,
} from '../../shared/domain/privacy-applicability.ts';
import { IntendedProcessingScopeSchema } from '../../shared/domain/privacy-processing-eligibility.ts';
import { PrivacyIsoTimestampSchema } from '../../shared/domain/privacy-subject.ts';

const EvidenceRef = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(300));

const PrivacyApplicabilityBusinessFactAuthorityRequestSchema = Schema.Struct({
  asOf: PrivacyIsoTimestampSchema,
  legalEntityId: Schema.String.check(Schema.isUUID()).pipe(
    Schema.brand('ApplicabilityLegalEntityId'),
    Schema.decodeTo(Schema.String),
  ),
  scope: PrivacyApplicabilityScopeIntentSchema,
  tenantId: Schema.String.check(Schema.isUUID()).pipe(
    Schema.brand('ApplicabilityTenantId'),
    Schema.decodeTo(Schema.String),
  ),
});
export type PrivacyApplicabilityBusinessFactAuthorityRequest =
  typeof PrivacyApplicabilityBusinessFactAuthorityRequestSchema.Type;

const PrivacyApplicabilityEligibilityAuthorityRequestSchema = Schema.Struct({
  asOf: PrivacyIsoTimestampSchema,
  intendedScope: IntendedProcessingScopeSchema,
  legalEntityId: Schema.String.check(Schema.isUUID()).pipe(
    Schema.brand('ApplicabilityLegalEntityId'),
    Schema.decodeTo(Schema.String),
  ),
  tenantId: Schema.String.check(Schema.isUUID()).pipe(
    Schema.brand('ApplicabilityTenantId'),
    Schema.decodeTo(Schema.String),
  ),
});
export type PrivacyApplicabilityEligibilityAuthorityRequest =
  typeof PrivacyApplicabilityEligibilityAuthorityRequestSchema.Type;

const TrustedPrivacyApplicabilityBusinessFactAuthorityResultSchema = Schema.Struct({
  asOf: PrivacyIsoTimestampSchema,
  authority: PrivacyApplicabilityAuthoritySchema,
  evidenceRefs: Schema.Array(EvidenceRef).check(Schema.isMinLength(1), Schema.isMaxLength(32)),
  receiptRef: EvidenceRef,
  scope: PrivacyApplicabilityScopeSchema,
  status: Schema.Literals(['CURRENT', 'STALE', 'CONFLICT', 'UNAVAILABLE']),
});
export type TrustedPrivacyApplicabilityBusinessFactAuthorityResult =
  typeof TrustedPrivacyApplicabilityBusinessFactAuthorityResultSchema.Type;

const TrustedPrivacyApplicabilityEligibilityAuthorityResultSchema =
  PrivacyApplicabilityEligibilityAuthorityResultSchema;
export type TrustedPrivacyApplicabilityEligibilityAuthorityResult =
  typeof TrustedPrivacyApplicabilityEligibilityAuthorityResultSchema.Type;

export class PrivacyApplicabilityBusinessFactAuthorityError extends Schema.TaggedError<PrivacyApplicabilityBusinessFactAuthorityError>()(
  'PrivacyApplicabilityBusinessFactAuthorityError',
  {
    code: Schema.Literals(['AUTHORITY_UNAVAILABLE', 'AUTHORITY_CONFLICT', 'AUTHORITY_STALE', 'MISSING_AUTHORITY']),
    reason: Schema.String,
  },
) {}
