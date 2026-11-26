import { PrincipalIdSchema } from '@app/core-runtime/auth/external-identity-contracts';
import { Schema } from 'effect';

import { PrivacyIsoTimestampSchema } from './privacy-subject.ts';

/**
 * Operator-authorized source synchronization, not a consent receipt or a GDPR applicability finding.
 * None of these pins are sender input. Only the dedicated AKROS demo company and source can be enrolled.
 */
export const SourceSyncProcessingPolicySchema = Schema.Struct({
  active: Schema.Boolean,
  callers: Schema.NonEmptyArray(
    Schema.Struct({
      authMethod: Schema.Literals(['api_key', 'system']),
      principalId: PrincipalIdSchema,
    }),
  ).check(Schema.isMaxLength(8)),
  customerRouteId: Schema.Literal('5158ef08-7315-57e1-a9ed-b0fef8cd9ac1'),
  dataUse: Schema.Literal('SOURCE_CUSTOMER_SYNC'),
  effectiveFrom: PrivacyIsoTimestampSchema,
  groupRouteId: Schema.Literal('5a6fb39a-c26e-4186-9dc2-5e410210d36c'),
  issuer: Schema.Literal('symmy-akros'),
  legalEntityId: Schema.Literal('c0c78a3e-6e2a-57e0-9d0d-86253499fee7'),
  namespace: Schema.Literal('akros-erp'),
  policyId: Schema.Literal('akros-symmy-source-sync-v2'),
  purpose: Schema.Literal('CUSTOMER_IMPORT'),
  reason: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1000)),
  revision: Schema.Literal('v2'),
  tenantId: Schema.Literal('bceaa540-13eb-5508-9ac0-9ed7e40a2ee9'),
  validUntil: PrivacyIsoTimestampSchema,
});
export type SourceSyncProcessingPolicy = typeof SourceSyncProcessingPolicySchema.Type;

// Evidence retains the protocol's opaque strings without adding request-side trim or length checks.
const EvidenceOccurrenceIdSchema = Schema.String.pipe(Schema.brand('PrivacySourceOccurrenceId'));
const EvidenceRecordIdSchema = Schema.String.pipe(Schema.brand('PrivacySourceSubjectRecordId'));
const EvidenceResourceIdSchema = Schema.String.pipe(Schema.brand('PrivacySourceTargetId'));
const EvidenceConsumerModuleIdSchema = Schema.String.pipe(Schema.brand('PrivacySourceConsumerModuleId'));

export const SourceSyncProcessingEvidenceTargetSchema = Schema.Struct({
  kind: Schema.String,
  resourceId: EvidenceResourceIdSchema,
});

// Decode absence as Option, then project it to an explicit transport null without unbranding populated targets.
const EvidenceTargetTransportSchema = Schema.OptionFromNullOr(SourceSyncProcessingEvidenceTargetSchema).pipe(
  Schema.decodeTo(Schema.flip(Schema.OptionFromNullOr(Schema.toType(SourceSyncProcessingEvidenceTargetSchema)))),
);

/** Source-scoped operational authority: does not fabricate subject identity, legal basis or consent. */
export const SourceSyncProcessingEvidenceSchema = Schema.TaggedStruct('SOURCE_SYNC_PROCESSING_POLICY', {
  consumerModuleId: EvidenceConsumerModuleIdSchema,
  dataUse: Schema.Literal('SOURCE_CUSTOMER_SYNC'),
  legalEntityId: SourceSyncProcessingPolicySchema.fields.legalEntityId,
  operation: Schema.String,
  policyId: SourceSyncProcessingPolicySchema.fields.policyId,
  policyRevision: SourceSyncProcessingPolicySchema.fields.revision,
  purpose: SourceSyncProcessingPolicySchema.fields.purpose,
  source: Schema.Struct({
    issuer: Schema.String,
    namespace: Schema.String,
    occurrenceId: EvidenceOccurrenceIdSchema,
    recordId: EvidenceRecordIdSchema,
    recordType: Schema.String,
    routeRef: Schema.String,
  }),
  target: EvidenceTargetTransportSchema,
  tenantId: SourceSyncProcessingPolicySchema.fields.tenantId,
  trustedDecisionTime: PrivacyIsoTimestampSchema,
  validUntil: PrivacyIsoTimestampSchema,
});
