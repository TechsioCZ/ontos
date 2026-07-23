import { Schema } from '@modern-js/plugin-bff/effect-client';
export declare const getTaskPropertyDeletionImpactPayloadSchema: Schema.Struct<{
    readonly collectionId: Schema.String;
    readonly propertyDefinitionId: Schema.String;
}>;
export declare const taskPropertyDeletionImpactSchema: Schema.Struct<{
    readonly impactCount: Schema.Finite;
    readonly impactRevision: Schema.optional<Schema.String>;
    readonly propertyDefinitionId: Schema.String;
    readonly revision: Schema.Finite;
}>;
export type GetTaskPropertyDeletionImpactPayload = typeof getTaskPropertyDeletionImpactPayloadSchema.Type;
export type TaskPropertyDeletionImpact = typeof taskPropertyDeletionImpactSchema.Type;
