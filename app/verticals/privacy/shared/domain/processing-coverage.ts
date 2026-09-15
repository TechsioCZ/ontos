import { Schema } from 'effect';

import { PrivacyApplicabilityDecisionSchema, PrivacyApplicabilityScopeSchema } from './privacy-applicability.ts';
import { PrivacyOwnerResourceRefSchema } from './privacy-owner-resource-ref.ts';
import { PrivacyIsoTimestampSchema } from './privacy-subject.ts';
import { ProcessingScopeRefSchema } from './privacy-responsibility-assignment.ts';
import { PrivacyResponsibilityAssignmentRefSchema } from '../resources/privacy-responsibility-assignment.ts';
import { ProcessingActivityRefSchema } from '../resources/processing-activity.ts';
import { ProcessingPurposeRefSchema } from '../resources/processing-purpose.ts';

const ReferenceId = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(300));
const Key = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(200));
const ModuleId = Key.pipe(Schema.brand('ModuleId'));
const TenantId = Schema.String.check(Schema.isUUID()).pipe(Schema.brand('TenantId'));
const LegalEntityId = Schema.String.check(Schema.isUUID()).pipe(Schema.brand('LegalEntityId'));
const PurposeVersionId = Schema.String.check(Schema.isUUID()).pipe(Schema.brand('PurposeVersionId'));
const RuleVersionId = ReferenceId.pipe(Schema.brand('RuleVersionId'));

export { PrivacyOwnerResourceRefSchema } from './privacy-owner-resource-ref.ts';
export type { PrivacyOwnerResourceRef } from './privacy-owner-resource-ref.ts';

export const PersonalDataCoverageSchema = Schema.Struct({
  dataCategoryRef: PrivacyOwnerResourceRefSchema,
  ownerCapability: Key,
  ownerModuleId: ModuleId,
  recordContentScope: Key,
  systemOfRecordRef: PrivacyOwnerResourceRefSchema,
});
export type PersonalDataCoverage = typeof PersonalDataCoverageSchema.Type;

export const ProcessingRecipientTransferSchema = Schema.Struct({
  dataCategoryRefs: Schema.Array(PrivacyOwnerResourceRefSchema).check(Schema.isMaxLength(64)),
  downstreamSystemRefs: Schema.Array(PrivacyOwnerResourceRefSchema).check(Schema.isMaxLength(64)),
  recipientTarget: Schema.Union([
    Schema.Struct({ recipientCategoryRef: PrivacyOwnerResourceRefSchema }),
    Schema.Struct({ recipientRef: PrivacyOwnerResourceRefSchema }),
  ]),
  role: Schema.Literals(['CONTROLLER', 'PROCESSOR', 'RECIPIENT']),
});
export type ProcessingRecipientTransfer = typeof ProcessingRecipientTransferSchema.Type;

export const ProcessingActivityOwnerCapabilityBindingSchema = Schema.Struct({
  dataCategoryRef: PrivacyOwnerResourceRefSchema,
  ownerCapability: Key,
  ownerModuleId: ModuleId,
  systemOfRecordRef: PrivacyOwnerResourceRefSchema,
});
export type ProcessingActivityOwnerCapabilityBinding = typeof ProcessingActivityOwnerCapabilityBindingSchema.Type;

/** The authority must attest the complete Processing Activity scope, not only its opaque scope id. */
export const ProcessingActivityAuthorityScopeSchema = Schema.Struct({
  applicabilityScope: PrivacyApplicabilityScopeSchema,
  purposeRef: ProcessingPurposeRefSchema,
  purposeVersionId: PurposeVersionId,
  responsibilityAssignmentRefs: Schema.Array(PrivacyResponsibilityAssignmentRefSchema).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(32),
  ),
});
export type ProcessingActivityAuthorityScope = typeof ProcessingActivityAuthorityScopeSchema.Type;

export const ProcessingRetentionReferenceSchema = Schema.Struct({
  applicabilityDecisionRef: ReferenceId,
  asOf: PrivacyIsoTimestampSchema,
  controllerRef: PrivacyOwnerResourceRefSchema,
  dataCategoryRefs: Schema.Array(PrivacyOwnerResourceRefSchema).check(Schema.isMaxLength(64)),
  legalEntityId: LegalEntityId,
  purposeVersionId: PurposeVersionId,
  recordContentScopes: Schema.Array(Key).check(Schema.isMinLength(1), Schema.isMaxLength(64)),
  ruleRef: PrivacyOwnerResourceRefSchema,
  ruleVersionId: RuleVersionId,
  tenantId: TenantId,
});
export type ProcessingRetentionReference = typeof ProcessingRetentionReferenceSchema.Type;

/**
 * Private result of the authoritative processing inventory/ownership seam.
 * The public Processing Activity payload never supplies these facts.
 */
export const ProcessingActivityAuthoritativeCoverageSchema = Schema.Struct({
  activityRef: ProcessingActivityRefSchema,
  applicabilityDecisions: Schema.Array(PrivacyApplicabilityDecisionSchema).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(32),
  ),
  authorityRef: ReferenceId,
  controllerRefs: Schema.Array(PrivacyOwnerResourceRefSchema).check(Schema.isMinLength(1), Schema.isMaxLength(32)),
  dataCategoryRefs: Schema.Array(PrivacyOwnerResourceRefSchema).check(Schema.isMinLength(1), Schema.isMaxLength(64)),
  dataCoverage: Schema.Array(PersonalDataCoverageSchema).check(Schema.isMinLength(1), Schema.isMaxLength(64)),
  evidenceRefs: Schema.Array(ReferenceId).check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  legalEntityId: LegalEntityId,
  observedAt: PrivacyIsoTimestampSchema,
  ownerCapabilityBindings: Schema.Array(ProcessingActivityOwnerCapabilityBindingSchema).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(64),
  ),
  processingScope: ProcessingActivityAuthorityScopeSchema,
  processingScopeRef: ProcessingScopeRefSchema,
  recipientRefs: Schema.Array(PrivacyOwnerResourceRefSchema).check(Schema.isMaxLength(64)),
  recipientTransfers: Schema.Array(ProcessingRecipientTransferSchema).check(Schema.isMaxLength(64)),
  retentionCoverage: Schema.Array(ProcessingRetentionReferenceSchema).check(Schema.isMaxLength(64)),
  revision: ReferenceId,
  systemOfRecordRefs: Schema.Array(PrivacyOwnerResourceRefSchema).check(Schema.isMinLength(1), Schema.isMaxLength(64)),
  tenantId: TenantId,
});
export type ProcessingActivityAuthoritativeCoverage = typeof ProcessingActivityAuthoritativeCoverageSchema.Type;
