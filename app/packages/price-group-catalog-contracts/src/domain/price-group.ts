import { DateTime, Option, Schema, SchemaGetter } from 'effect';

import { PriceGroupRefSchema } from '../resources/price-group.ts';

export { PriceGroupResourceIdSchema as PriceGroupIdSchema } from '../resources/price-group.ts';

const nonEmptyText = Schema.String.check(Schema.isMinLength(1), Schema.isTrimmed());
const boundedText = (maximum: number) => nonEmptyText.check(Schema.isMaxLength(maximum));
const positiveSafeInteger = Schema.Finite.check(
  Schema.isInt(),
  Schema.isBetween({ maximum: Number.MAX_SAFE_INTEGER, minimum: 1 }),
);
const nonNegativeSafeInteger = Schema.Finite.check(
  Schema.isInt(),
  Schema.isBetween({ maximum: Number.MAX_SAFE_INTEGER, minimum: 0 }),
);
const uuid = Schema.String.check(Schema.isUUID(), Schema.isTrimmed());

export const PriceGroupInstantSchema = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u),
  Schema.makeFilter((value) => {
    const parsed = DateTime.make(value);
    const canonicalInput = value.length === 20 ? value.replace(/Z$/u, '.000Z') : value;
    return Option.isSome(parsed) && DateTime.formatIso(parsed.value) === canonicalInput
      ? undefined
      : 'Expected a canonical UTC timestamp';
  }),
).pipe(
  Schema.decode({
    decode: SchemaGetter.dateTimeUtcFromInput<string>().map(DateTime.formatIso),
    encode: SchemaGetter.dateTimeUtcFromInput<string>().map(DateTime.formatIso),
  }),
);

export const PriceGroupDefinitionRevisionIdSchema = uuid.pipe(
  Schema.brand('PriceGroupDefinitionRevisionId'),
  Schema.decodeTo(uuid),
);
export const PriceGroupActionInvocationIdSchema = uuid.pipe(
  Schema.brand('PriceGroupActionInvocationId'),
  Schema.decodeTo(uuid),
);
export const PriceGroupActorPrincipalIdSchema = uuid.pipe(
  Schema.brand('PriceGroupActorPrincipalId'),
  Schema.decodeTo(uuid),
);
export const PriceGroupCodeSchema = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(64),
  Schema.isPattern(/^[A-Z][A-Z0-9_]*$/u),
);
export const PriceGroupMeaningFingerprintSchema = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u));
export const PriceGroupNameSchema = boundedText(160);
export const PriceGroupDescriptionSchema = boundedText(2000);
export const PriceGroupPurposeSchema = boundedText(1000);
export const PriceGroupReasonSchema = boundedText(1000);
export const CatalogRevisionSchema = positiveSafeInteger.pipe(
  Schema.brand('PriceGroupCatalogRevision'),
  Schema.decodeTo(positiveSafeInteger),
);
export const CatalogFenceRevisionSchema = nonNegativeSafeInteger.pipe(
  Schema.brand('PriceGroupCatalogFenceRevision'),
  Schema.decodeTo(nonNegativeSafeInteger),
);
export const PriceGroupDefinitionRevisionNumberSchema = positiveSafeInteger.pipe(
  Schema.brand('PriceGroupDefinitionRevisionNumber'),
  Schema.decodeTo(positiveSafeInteger),
);

export const StablePriceGroupRefSchema = PriceGroupRefSchema;
export type StablePriceGroupRef = typeof StablePriceGroupRefSchema.Type;

export const PriceGroupEffectivePeriodSchema = Schema.Struct({
  effectiveFrom: PriceGroupInstantSchema,
  // oxlint-disable-next-line effect-native/no-nullable-schema-field -- null is the stable wire sentinel for an open-ended half-open period; expires: 2027-03-31.
  effectiveTo: Schema.NullOr(PriceGroupInstantSchema),
}).check(
  Schema.makeFilter((period) =>
    period.effectiveTo === null || period.effectiveFrom < period.effectiveTo
      ? undefined
      : 'Price Group effective period must be a non-empty half-open interval',
  ),
);
export type PriceGroupEffectivePeriod = typeof PriceGroupEffectivePeriodSchema.Type;

export const PriceGroupAuditProvenanceSchema = Schema.Struct({
  actionInvocationId: PriceGroupActionInvocationIdSchema,
  actorPrincipalId: PriceGroupActorPrincipalIdSchema,
  reason: PriceGroupReasonSchema,
  trustedAt: PriceGroupInstantSchema,
});
export type PriceGroupAuditProvenance = typeof PriceGroupAuditProvenanceSchema.Type;

export const PriceGroupLifecycleSchema = Schema.Struct({
  activeFrom: PriceGroupInstantSchema,
  // oxlint-disable-next-line effect-native/no-nullable-schema-field -- null distinguishes an ACTIVE identity from terminal retirement on the public contract; expires: 2027-03-31.
  retiredAt: Schema.NullOr(PriceGroupInstantSchema),
  state: Schema.Literals(['ACTIVE', 'RETIRED']),
}).check(
  Schema.makeFilter((lifecycle) => {
    if (lifecycle.state === 'ACTIVE') {
      return lifecycle.retiredAt === null ? undefined : 'An ACTIVE Price Group cannot carry retirement evidence';
    }
    if (lifecycle.retiredAt === null) {
      return 'A RETIRED Price Group must carry its terminal retirement instant';
    }
    return lifecycle.activeFrom <= lifecycle.retiredAt ? undefined : 'Price Group retirement cannot precede activation';
  }),
);
export type PriceGroupLifecycle = typeof PriceGroupLifecycleSchema.Type;

export const PriceGroupIdentitySchema = Schema.Struct({
  businessCode: PriceGroupCodeSchema,
  classificationPurpose: PriceGroupPurposeSchema,
  created: PriceGroupAuditProvenanceSchema,
  createdAtCatalogRevision: CatalogRevisionSchema,
  lifecycle: PriceGroupLifecycleSchema,
  meaningFingerprint: PriceGroupMeaningFingerprintSchema,
  priceGroupRef: StablePriceGroupRefSchema,
});
export type PriceGroupIdentity = typeof PriceGroupIdentitySchema.Type;

const checkedCompatibilityContractId = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(160),
  Schema.isPattern(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u),
);
export const PriceGroupCompatibilityContractIdSchema = checkedCompatibilityContractId.pipe(
  Schema.brand('PriceGroupCompatibilityContractId'),
  Schema.decodeTo(checkedCompatibilityContractId),
);
export const PriceGroupCompatibilityContractVersionSchema = positiveSafeInteger.pipe(
  Schema.brand('PriceGroupCompatibilityContractVersion'),
  Schema.decodeTo(positiveSafeInteger),
);
export const PriceGroupCompatibilityContractSchema = Schema.Struct({
  contractId: PriceGroupCompatibilityContractIdSchema,
  version: PriceGroupCompatibilityContractVersionSchema,
});
export type PriceGroupCompatibilityContract = typeof PriceGroupCompatibilityContractSchema.Type;

export const PriceGroupDefinitionRevisionSchema = Schema.Struct({
  acceptedCatalogRevision: CatalogRevisionSchema,
  classificationPurpose: PriceGroupPurposeSchema,
  compatibilityContracts: Schema.Array(PriceGroupCompatibilityContractSchema).check(Schema.isMinLength(1)),
  created: PriceGroupAuditProvenanceSchema,
  definitionRevisionId: PriceGroupDefinitionRevisionIdSchema,
  description: PriceGroupDescriptionSchema,
  displayName: PriceGroupNameSchema,
  effectivePeriod: PriceGroupEffectivePeriodSchema,
  meaningFingerprint: PriceGroupMeaningFingerprintSchema,
  // oxlint-disable-next-line effect-native/no-nullable-schema-field -- the initial revision has no predecessor by definition; expires: 2027-03-31.
  previousDefinitionRevisionId: Schema.NullOr(PriceGroupDefinitionRevisionIdSchema),
  priceGroupRef: StablePriceGroupRefSchema,
  revisionNumber: PriceGroupDefinitionRevisionNumberSchema,
}).check(
  Schema.makeFilter((revision) => {
    const predecessorContractIsValid =
      (revision.revisionNumber === 1 && revision.previousDefinitionRevisionId === null) ||
      (revision.revisionNumber > 1 && revision.previousDefinitionRevisionId !== null);
    if (!predecessorContractIsValid) {
      return 'Only the initial Price Group definition may omit its predecessor';
    }
    const contractKeys = revision.compatibilityContracts.map(
      (contract) => `${contract.contractId}@${contract.version}`,
    );
    return new Set(contractKeys).size === contractKeys.length
      ? undefined
      : 'Compatibility Contract support must not contain duplicate identity/version pairs';
  }),
);
export type PriceGroupDefinitionRevision = typeof PriceGroupDefinitionRevisionSchema.Type;

export const PriceGroupCurrentEvidenceSchema = Schema.Struct({
  catalogRevision: CatalogRevisionSchema,
  definitionEffectivePeriod: PriceGroupEffectivePeriodSchema,
  definitionRevisionId: PriceGroupDefinitionRevisionIdSchema,
  definitionRevisionNumber: PriceGroupDefinitionRevisionNumberSchema,
  meaningFingerprint: PriceGroupMeaningFingerprintSchema,
  observedAt: PriceGroupInstantSchema,
  priceGroupRef: StablePriceGroupRefSchema,
}).check(
  Schema.makeFilter((evidence) =>
    evidence.definitionEffectivePeriod.effectiveFrom <= evidence.observedAt &&
    (evidence.definitionEffectivePeriod.effectiveTo === null ||
      evidence.observedAt < evidence.definitionEffectivePeriod.effectiveTo)
      ? undefined
      : 'Current evidence observation must fall inside the exact half-open definition period',
  ),
);
export type PriceGroupCurrentEvidence = typeof PriceGroupCurrentEvidenceSchema.Type;

export const ExpectedPriceGroupCurrentEvidenceSchema = Schema.Struct({
  catalogRevision: CatalogRevisionSchema,
  definitionRevisionId: PriceGroupDefinitionRevisionIdSchema,
  definitionRevisionNumber: PriceGroupDefinitionRevisionNumberSchema,
  meaningFingerprint: PriceGroupMeaningFingerprintSchema,
  priceGroupRef: StablePriceGroupRefSchema,
});
export type ExpectedPriceGroupCurrentEvidence = typeof ExpectedPriceGroupCurrentEvidenceSchema.Type;

export const PriceGroupCompatibilityEvidenceSchema = Schema.Struct({
  catalogRevision: CatalogRevisionSchema,
  definitionEffectivePeriod: PriceGroupEffectivePeriodSchema,
  definitionRevisionId: PriceGroupDefinitionRevisionIdSchema,
  definitionRevisionNumber: PriceGroupDefinitionRevisionNumberSchema,
  meaningFingerprint: PriceGroupMeaningFingerprintSchema,
  priceGroupRef: StablePriceGroupRefSchema,
  requiredContract: PriceGroupCompatibilityContractSchema,
  trustedOperationAt: PriceGroupInstantSchema,
  verifiedAt: PriceGroupInstantSchema,
}).check(
  Schema.makeFilter((evidence) => {
    const operationFallsInsideDefinition =
      evidence.definitionEffectivePeriod.effectiveFrom <= evidence.trustedOperationAt &&
      (evidence.definitionEffectivePeriod.effectiveTo === null ||
        evidence.trustedOperationAt < evidence.definitionEffectivePeriod.effectiveTo);
    if (!operationFallsInsideDefinition) {
      return 'Compatibility Evidence must bind an operation time inside the exact definition period';
    }
    return evidence.trustedOperationAt <= evidence.verifiedAt
      ? undefined
      : 'Compatibility Evidence cannot be verified before its trusted operation time';
  }),
);
export type PriceGroupCompatibilityEvidence = typeof PriceGroupCompatibilityEvidenceSchema.Type;

export const PriceGroupCatalogObservationSchema = Schema.Struct({
  catalogRevision: CatalogFenceRevisionSchema,
  observedAt: PriceGroupInstantSchema,
  trustedOperationAt: PriceGroupInstantSchema,
}).check(
  Schema.makeFilter((observation) =>
    observation.trustedOperationAt <= observation.observedAt
      ? undefined
      : 'Catalog observation cannot precede its trusted operation time',
  ),
);
export type PriceGroupCatalogObservation = typeof PriceGroupCatalogObservationSchema.Type;

export const PriceGroupRetirementEvidenceSchema = Schema.Struct({
  acceptedCatalogRevision: CatalogRevisionSchema,
  currentDefinitionRevisionId: PriceGroupDefinitionRevisionIdSchema,
  currentDefinitionRevisionNumber: PriceGroupDefinitionRevisionNumberSchema,
  priceGroupRef: StablePriceGroupRefSchema,
  retiredAt: PriceGroupInstantSchema,
  retirementProvenance: PriceGroupAuditProvenanceSchema,
  trustedOperationAt: PriceGroupInstantSchema,
  verifiedAt: PriceGroupInstantSchema,
}).check(
  Schema.makeFilter((evidence) =>
    evidence.retiredAt <= evidence.trustedOperationAt && evidence.trustedOperationAt <= evidence.verifiedAt
      ? undefined
      : 'Retirement evidence must precede the trusted operation and its verification',
  ),
);
export type PriceGroupRetirementEvidence = typeof PriceGroupRetirementEvidenceSchema.Type;

export const PriceGroupRetirementAcceptanceSchema = Schema.Struct({
  acceptedCatalogRevision: CatalogRevisionSchema,
  currentDefinitionRevisionId: PriceGroupDefinitionRevisionIdSchema,
  currentDefinitionRevisionNumber: PriceGroupDefinitionRevisionNumberSchema,
  priceGroupRef: StablePriceGroupRefSchema,
  retirementEffectiveAt: PriceGroupInstantSchema,
  retirementProvenance: PriceGroupAuditProvenanceSchema,
  trustedOperationAt: PriceGroupInstantSchema,
  verifiedAt: PriceGroupInstantSchema,
}).check(
  Schema.makeFilter((acceptance) => {
    if (acceptance.retirementProvenance.trustedAt !== acceptance.trustedOperationAt) {
      return 'Retirement acceptance provenance must bind the trusted operation time';
    }
    if (acceptance.trustedOperationAt > acceptance.retirementEffectiveAt) {
      return 'Retirement acceptance cannot schedule a retirement before its trusted operation time';
    }
    return acceptance.trustedOperationAt <= acceptance.verifiedAt
      ? undefined
      : 'Retirement acceptance cannot be verified before its trusted operation time';
  }),
);
export type PriceGroupRetirementAcceptance = typeof PriceGroupRetirementAcceptanceSchema.Type;

export const PriceGroupIncompatibleEvidenceSchema = Schema.Struct({
  definitionRevisionId: PriceGroupDefinitionRevisionIdSchema,
  definitionRevisionNumber: PriceGroupDefinitionRevisionNumberSchema,
  evaluatedCatalogRevision: CatalogRevisionSchema,
  meaningFingerprint: PriceGroupMeaningFingerprintSchema,
  priceGroupRef: StablePriceGroupRefSchema,
  requiredContract: PriceGroupCompatibilityContractSchema,
  trustedOperationAt: PriceGroupInstantSchema,
  verifiedAt: PriceGroupInstantSchema,
}).check(
  Schema.makeFilter((evidence) =>
    evidence.trustedOperationAt <= evidence.verifiedAt
      ? undefined
      : 'Incompatibility evidence cannot be verified before its trusted operation time',
  ),
);
export type PriceGroupIncompatibleEvidence = typeof PriceGroupIncompatibleEvidenceSchema.Type;

export const PriceGroupCompatibilityDecisionSchema = Schema.Union([
  Schema.Struct({ evidence: PriceGroupCompatibilityEvidenceSchema, kind: Schema.Literal('USABLE') }),
  Schema.Struct({
    catalogObservation: PriceGroupCatalogObservationSchema,
    kind: Schema.Literal('MISSING'),
    priceGroupRef: StablePriceGroupRefSchema,
  }),
  Schema.Struct({ evidence: PriceGroupRetirementEvidenceSchema, kind: Schema.Literal('RETIRED') }),
  Schema.Struct({ evidence: PriceGroupIncompatibleEvidenceSchema, kind: Schema.Literal('INCOMPATIBLE') }),
]);
export type PriceGroupCompatibilityDecision = typeof PriceGroupCompatibilityDecisionSchema.Type;

export const priceGroupPeriodContains = (period: PriceGroupEffectivePeriod, instant: string): boolean =>
  period.effectiveFrom <= instant && (period.effectiveTo === null || instant < period.effectiveTo);
