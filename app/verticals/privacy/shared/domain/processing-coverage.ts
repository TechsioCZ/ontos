import { Schema } from 'effect';

const ReferenceId = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(300));
const Key = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(200));
const ReferenceList = Schema.Array(ReferenceId).check(Schema.isMaxLength(64));
const ModuleId = Key.pipe(Schema.brand('ModuleId'));
const ResourceId = ReferenceId.pipe(Schema.brand('ResourceId'));
const TenantId = Schema.String.check(Schema.isUUID()).pipe(Schema.brand('TenantId'));
const PurposeVersionId = Schema.String.check(Schema.isUUID()).pipe(Schema.brand('PurposeVersionId'));
const RuleVersionId = ReferenceId.pipe(Schema.brand('RuleVersionId'));

/** A pointer to an owner resource. The pointed-to fact remains in that owner's system. */
export const PrivacyOwnerResourceRefSchema = Schema.Struct({
  moduleId: ModuleId,
  resourceId: ResourceId,
  resourceType: Key,
  tenantId: TenantId,
});
export type PrivacyOwnerResourceRef = typeof PrivacyOwnerResourceRefSchema.Type;

export const PersonalDataCoverageSchema = Schema.Struct({
  dataCategoryRef: PrivacyOwnerResourceRefSchema,
  ownerCapability: Key,
  recordContentScope: Key,
  systemOfRecordRef: PrivacyOwnerResourceRefSchema,
});
export type PersonalDataCoverage = typeof PersonalDataCoverageSchema.Type;

export const ProcessingRecipientTransferSchema = Schema.Struct({
  dataCategoryRefs: ReferenceList,
  downstreamSystemRefs: ReferenceList,
  recipientTarget: Schema.Union([
    Schema.Struct({ recipientCategoryRef: PrivacyOwnerResourceRefSchema }),
    Schema.Struct({ recipientRef: PrivacyOwnerResourceRefSchema }),
  ]),
  role: Schema.Literals(['CONTROLLER', 'PROCESSOR', 'RECIPIENT']),
});
export type ProcessingRecipientTransfer = typeof ProcessingRecipientTransferSchema.Type;

export const ProcessingRetentionReferenceSchema = Schema.Struct({
  applicabilityDecisionRef: ReferenceId,
  controllerRef: PrivacyOwnerResourceRefSchema,
  dataCategoryRefs: ReferenceList,
  purposeVersionId: PurposeVersionId,
  recordContentScopes: Schema.Array(Key).check(Schema.isMinLength(1), Schema.isMaxLength(64)),
  ruleRef: PrivacyOwnerResourceRefSchema,
  ruleVersionId: RuleVersionId,
});
export type ProcessingRetentionReference = typeof ProcessingRetentionReferenceSchema.Type;
