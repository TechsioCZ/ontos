import { Schema } from '@modern-js/plugin-bff/effect-client';

export const getMultiSelectOptionDeletionImpactPayloadSchema = Schema.Struct({
  collectionId: Schema.String,
  optionId: Schema.String,
  propertyDefinitionId: Schema.String,
});

export const multiSelectOptionDeletionImpactSchema = Schema.Struct({
  definitionRevision: Schema.Finite,
  impactCount: Schema.Finite,
  impactToken: Schema.String,
  optionId: Schema.String,
  optionRevision: Schema.Finite,
  propertyDefinitionId: Schema.String,
});

export type GetMultiSelectOptionDeletionImpactPayload =
  typeof getMultiSelectOptionDeletionImpactPayloadSchema.Type;
export type MultiSelectOptionDeletionImpact = typeof multiSelectOptionDeletionImpactSchema.Type;
