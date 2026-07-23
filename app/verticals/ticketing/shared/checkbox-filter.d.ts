import { Schema } from '@modern-js/plugin-bff/effect-client';
export declare const filterTaskCheckboxValuesPayloadSchema: Schema.Struct<{
    readonly collectionId: Schema.String;
    readonly propertyDefinitionId: Schema.String;
    readonly value: Schema.Boolean;
}>;
export declare const filterTaskCheckboxValuesResponseSchema: Schema.Struct<{
    readonly taskIds: Schema.$Array<Schema.String>;
}>;
export type FilterTaskCheckboxValuesPayload = typeof filterTaskCheckboxValuesPayloadSchema.Type;
export type FilterTaskCheckboxValuesResponse = typeof filterTaskCheckboxValuesResponseSchema.Type;
