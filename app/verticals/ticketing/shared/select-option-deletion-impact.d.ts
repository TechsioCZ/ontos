import type { Schema } from '@modern-js/plugin-bff/effect-client';

export declare const getSelectOptionDeletionImpactPayloadSchema: Schema.Struct<{
  readonly collectionId: Schema.String;
  readonly optionId: Schema.String;
  readonly propertyDefinitionId: Schema.String;
}>;
export declare const selectOptionDeletionImpactSchema: Schema.Struct<{
  readonly definitionRevision: Schema.Finite;
  readonly impactCount: Schema.Finite;
  readonly optionId: Schema.String;
  readonly optionRevision: Schema.Finite;
  readonly propertyDefinitionId: Schema.String;
}>;
export type GetSelectOptionDeletionImpactPayload =
  typeof getSelectOptionDeletionImpactPayloadSchema.Type;
export type SelectOptionDeletionImpact = typeof selectOptionDeletionImpactSchema.Type;
