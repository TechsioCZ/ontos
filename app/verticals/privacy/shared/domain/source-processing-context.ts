import { SourceProcessingEligibilityRequestSchema } from '@app/privacy-contracts/source-processing-eligibility';
import { Schema } from 'effect';

import { PrivacyApplicabilityEligibilityAuthorityResultSchema } from './privacy-applicability.ts';
import { IntendedProcessingScopeSchema } from './privacy-processing-eligibility.ts';
import { PrivacyIsoTimestampSchema } from './privacy-subject.ts';

const Ref = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(300));

/** Deployment-governed business-fact context, never legal basis or consent. Every entry
 * refers to an existing durable Privacy applicability decision. Reloaded on each attempt. */
export const SourceProcessingContextSchema = Schema.Struct({
  applicabilityAuthority: PrivacyApplicabilityEligibilityAuthorityResultSchema,
  authMethod: Ref,
  authorityIncarnation: Ref,
  authorityRevision: Ref,
  contentScopeRefs: Schema.Array(Ref).check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  effectiveFrom: PrivacyIsoTimestampSchema,
  intendedScope: IntendedProcessingScopeSchema,
  legalEntityId: Schema.String.check(Schema.isUUID()).pipe(
    Schema.brand('PrivacySourceLegalEntityId'),
    Schema.decodeTo(Schema.String),
  ),
  principalId: Schema.String.check(Schema.isUUID()).pipe(
    Schema.brand('PrivacySourcePrincipalId'),
    Schema.decodeTo(Schema.String),
  ),
  request: SourceProcessingEligibilityRequestSchema,
  resourceRefs: Schema.Array(Ref).check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  targetAdmission: Schema.optionalKey(Schema.Literal('CURRENT_SOURCE_PERSON')),
  tenantId: Schema.String.check(Schema.isUUID()).pipe(
    Schema.brand('PrivacySourceTenantId'),
    Schema.decodeTo(Schema.String),
  ),
  validUntil: PrivacyIsoTimestampSchema,
}).check(
  Schema.makeFilter((context) =>
    context.targetAdmission === undefined ||
    (context.request.consumerModuleId === 'commerce.customer-context' &&
      context.request.operation === 'PROFILE_CREATE' &&
      context.request.source !== null &&
      context.request.partySourceReference !== undefined &&
      context.request.target === null &&
      context.intendedScope.operation === 'PROFILE_CREATE')
      ? undefined
      : 'Current source person target admission is limited to the exact approved Retail profile creation source context',
  ),
);
export type SourceProcessingContext = typeof SourceProcessingContextSchema.Type;
