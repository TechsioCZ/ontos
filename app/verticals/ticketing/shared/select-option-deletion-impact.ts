import { Schema } from '@modern-js/plugin-bff/effect-client';

export const getSelectOptionDeletionImpactPayloadSchema = Schema.Struct({
  collectionId: Schema.String,
  optionId: Schema.String,
  propertyDefinitionId: Schema.String,
});

export const selectOptionDeletionImpactSchema = Schema.Struct({
  definitionRevision: Schema.Finite,
  impactCount: Schema.Finite,
  optionId: Schema.String,
  optionRevision: Schema.Finite,
  propertyDefinitionId: Schema.String,
});

export type GetSelectOptionDeletionImpactPayload =
  typeof getSelectOptionDeletionImpactPayloadSchema.Type;
export type SelectOptionDeletionImpact = typeof selectOptionDeletionImpactSchema.Type;
