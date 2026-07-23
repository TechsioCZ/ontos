import { Schema } from '@modern-js/plugin-bff/effect-client';
export declare const getMultiSelectOptionDeletionImpactPayloadSchema: Schema.Struct<{
    readonly collectionId: Schema.String;
    readonly optionId: Schema.String;
    readonly propertyDefinitionId: Schema.String;
}>;
export declare const multiSelectOptionDeletionImpactSchema: Schema.Struct<{
    readonly definitionRevision: Schema.Finite;
    readonly impactCount: Schema.Finite;
    readonly impactToken: Schema.String;
    readonly optionId: Schema.String;
    readonly optionRevision: Schema.Finite;
    readonly propertyDefinitionId: Schema.String;
}>;
export type GetMultiSelectOptionDeletionImpactPayload = typeof getMultiSelectOptionDeletionImpactPayloadSchema.Type;
export type MultiSelectOptionDeletionImpact = typeof multiSelectOptionDeletionImpactSchema.Type;
