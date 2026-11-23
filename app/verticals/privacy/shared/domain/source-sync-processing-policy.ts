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
      principalId: Schema.String.check(Schema.isUUID()),
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

/** Source-scoped operational authority: does not fabricate subject identity, legal basis or consent. */
export const SourceSyncProcessingEvidenceSchema = Schema.TaggedStruct('SOURCE_SYNC_PROCESSING_POLICY', {
  consumerModuleId: Schema.String,
  dataUse: Schema.Literal('SOURCE_CUSTOMER_SYNC'),
  legalEntityId: SourceSyncProcessingPolicySchema.fields.legalEntityId,
  operation: Schema.String,
  policyId: SourceSyncProcessingPolicySchema.fields.policyId,
  policyRevision: SourceSyncProcessingPolicySchema.fields.revision,
  purpose: SourceSyncProcessingPolicySchema.fields.purpose,
  source: Schema.Struct({
    issuer: Schema.String,
    namespace: Schema.String,
    occurrenceId: Schema.String,
    recordId: Schema.String,
    recordType: Schema.String,
    routeRef: Schema.String,
  }),
  target: Schema.NullOr(Schema.Struct({ kind: Schema.String, resourceId: Schema.String })),
  tenantId: SourceSyncProcessingPolicySchema.fields.tenantId,
  trustedDecisionTime: PrivacyIsoTimestampSchema,
  validUntil: PrivacyIsoTimestampSchema,
});
