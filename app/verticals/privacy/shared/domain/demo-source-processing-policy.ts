import { Schema } from 'effect';

import { PrivacyIsoTimestampSchema } from './privacy-subject.ts';

/**
 * Deployment/operator authority for synthetic demo imports, not a legal basis for real-person processing.
 * None of these pins are sender input. Only the dedicated AKROS demo company and source can be enrolled.
 */
export const DemoSourceProcessingPolicySchema = Schema.Struct({
  active: Schema.Boolean,
  callers: Schema.NonEmptyArray(
    Schema.Struct({
      authMethod: Schema.Literals(['api_key', 'system']),
      principalId: Schema.String.check(Schema.isUUID()),
    }),
  ).check(Schema.isMaxLength(8)),
  customerRouteId: Schema.Literal('5158ef08-7315-57e1-a9ed-b0fef8cd9ac1'),
  dataUse: Schema.Literal('DEMO_TEST_DATA_ONLY'),
  effectiveFrom: PrivacyIsoTimestampSchema,
  groupRouteId: Schema.Literal('f637a6ec-865b-43bc-9c28-57783757f367'),
  issuer: Schema.Literal('symmy-akros'),
  legalEntityId: Schema.Literal('c0c78a3e-6e2a-57e0-9d0d-86253499fee7'),
  namespace: Schema.Literal('akros-erp'),
  policyId: Schema.Literal('akros-symmy-demo-test-data'),
  purpose: Schema.Literal('DEMO_CUSTOMER_IMPORT_TESTING'),
  reason: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1000)),
  revision: Schema.Literal('v1'),
  tenantId: Schema.Literal('bceaa540-13eb-5508-9ac0-9ed7e40a2ee9'),
  validUntil: PrivacyIsoTimestampSchema,
});
export type DemoSourceProcessingPolicy = typeof DemoSourceProcessingPolicySchema.Type;

/** Honest source-wide testing authority: deliberately no subject identity, legal basis or consent receipt. */
export const DemoSourceProcessingEvidenceSchema = Schema.TaggedStruct('DEMO_TEST_DATA_SOURCE_POLICY', {
  consumerModuleId: Schema.String,
  dataUse: Schema.Literal('DEMO_TEST_DATA_ONLY'),
  legalEntityId: DemoSourceProcessingPolicySchema.fields.legalEntityId,
  operation: Schema.String,
  policyId: DemoSourceProcessingPolicySchema.fields.policyId,
  policyRevision: DemoSourceProcessingPolicySchema.fields.revision,
  purpose: DemoSourceProcessingPolicySchema.fields.purpose,
  source: Schema.Struct({
    issuer: Schema.String,
    namespace: Schema.String,
    occurrenceId: Schema.String,
    recordId: Schema.String,
    recordType: Schema.String,
    routeRef: Schema.String,
  }),
  target: Schema.NullOr(Schema.Struct({ kind: Schema.String, resourceId: Schema.String })),
  tenantId: DemoSourceProcessingPolicySchema.fields.tenantId,
  trustedDecisionTime: PrivacyIsoTimestampSchema,
  validUntil: PrivacyIsoTimestampSchema,
});
