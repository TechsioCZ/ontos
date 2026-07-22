import { Schema } from '@modern-js/plugin-bff/effect-client';

export const getTaskPropertyDeletionImpactPayloadSchema = Schema.Struct({
  collectionId: Schema.String,
  propertyDefinitionId: Schema.String,
});

export const taskPropertyDeletionImpactSchema = Schema.Struct({
  impactCount: Schema.Finite,
  impactRevision: Schema.optional(Schema.String),
  propertyDefinitionId: Schema.String,
  revision: Schema.Finite,
});

export type GetTaskPropertyDeletionImpactPayload =
  typeof getTaskPropertyDeletionImpactPayloadSchema.Type;
export type TaskPropertyDeletionImpact = typeof taskPropertyDeletionImpactSchema.Type;
