import { Schema } from 'effect';

import {
  ExpectedPriceGroupCurrentEvidenceSchema,
  PriceGroupCompatibilityContractSchema,
  PriceGroupDescriptionSchema,
  PriceGroupEffectivePeriodSchema,
  PriceGroupInstantSchema,
  PriceGroupMeaningFingerprintSchema,
  PriceGroupNameSchema,
  PriceGroupPurposeSchema,
  PriceGroupReasonSchema,
} from '../domain/price-group.ts';

const compatibilityContractsSchema = Schema.Array(PriceGroupCompatibilityContractSchema).check(
  Schema.isMinLength(1),
  Schema.makeFilter((contracts) => {
    const hasDuplicate = contracts.some((candidate, index) =>
      contracts
        .slice(0, index)
        .some(({ contractId, version }) => contractId === candidate.contractId && version === candidate.version),
    );
    return hasDuplicate
      ? 'Compatibility Contract support must not contain duplicate identity/version pairs'
      : undefined;
  }),
);
const isEffectivePeriod = Schema.is(PriceGroupEffectivePeriodSchema);

export const CreatePriceGroupDefinitionRevisionPayloadSchema = Schema.Struct({
  classificationPurpose: PriceGroupPurposeSchema,
  compatibilityContracts: compatibilityContractsSchema,
  description: PriceGroupDescriptionSchema,
  displayName: PriceGroupNameSchema,
  effectiveFrom: PriceGroupInstantSchema,
  // oxlint-disable-next-line effect-native/no-nullable-schema-field -- null is the stable wire sentinel for an open-ended definition period; expires: 2027-03-31.
  effectiveTo: Schema.NullOr(PriceGroupInstantSchema),
  expectedCurrent: ExpectedPriceGroupCurrentEvidenceSchema,
  meaningFingerprint: PriceGroupMeaningFingerprintSchema,
  reason: PriceGroupReasonSchema,
  sameMeaningAttested: Schema.Literal(true),
}).check(
  Schema.makeFilter((payload) =>
    isEffectivePeriod({ effectiveFrom: payload.effectiveFrom, effectiveTo: payload.effectiveTo })
      ? undefined
      : 'Price Group effective period must be a non-empty half-open interval',
  ),
);
export type CreatePriceGroupDefinitionRevisionPayload = typeof CreatePriceGroupDefinitionRevisionPayloadSchema.Type;

export { PriceGroupDefinitionRevisionSchema as CreatePriceGroupDefinitionRevisionResultSchema } from '../domain/price-group.ts';
