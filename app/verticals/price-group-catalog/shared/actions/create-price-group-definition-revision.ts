import { Schema } from 'effect';

import {
  ExpectedPriceGroupCurrentEvidenceSchema,
  PriceGroupCompatibilityContractSchema,
  PriceGroupDescriptionSchema,
  PriceGroupDefinitionRevisionIdSchema,
  PriceGroupEffectivePeriodSchema,
  PriceGroupInstantSchema,
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
  reason: PriceGroupReasonSchema,
  semanticDecision: Schema.Union([
    Schema.Struct({
      comparedDefinitionRevisionId: PriceGroupDefinitionRevisionIdSchema,
      decision: Schema.Literal('SAME_MEANING'),
    }),
    Schema.Struct({ decision: Schema.Literal('MATERIAL_CHANGE') }),
  ]),
}).check(
  Schema.makeFilter((payload) => {
    if (!isEffectivePeriod({ effectiveFrom: payload.effectiveFrom, effectiveTo: payload.effectiveTo })) {
      return 'Price Group effective period must be a non-empty half-open interval';
    }
    return payload.semanticDecision.decision === 'SAME_MEANING' &&
      payload.semanticDecision.comparedDefinitionRevisionId !== payload.expectedCurrent.definitionRevisionId
      ? 'A SAME_MEANING decision must compare the exact expected Current definition'
      : undefined;
  }),
);
export type CreatePriceGroupDefinitionRevisionPayload = typeof CreatePriceGroupDefinitionRevisionPayloadSchema.Type;

export { PriceGroupDefinitionRevisionSchema as CreatePriceGroupDefinitionRevisionResultSchema } from '../domain/price-group.ts';
