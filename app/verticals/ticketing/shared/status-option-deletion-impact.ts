import { Schema } from '@modern-js/plugin-bff/effect-client';

export const getStatusOptionDeletionImpactPayloadSchema = Schema.Struct({
  collectionId: Schema.String,
  optionId: Schema.String,
  propertyDefinitionId: Schema.String,
});

export const statusOptionDeletionImpactSchema = Schema.Struct({
  definitionRevision: Schema.Finite,
  impactCount: Schema.Finite,
  impactToken: Schema.String,
  optionId: Schema.String,
  optionRevision: Schema.Finite,
  propertyDefinitionId: Schema.String,
});

export type GetStatusOptionDeletionImpactPayload =
  typeof getStatusOptionDeletionImpactPayloadSchema.Type;
export type StatusOptionDeletionImpact = typeof statusOptionDeletionImpactSchema.Type;
