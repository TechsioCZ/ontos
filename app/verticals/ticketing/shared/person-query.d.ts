import { Schema } from '@modern-js/plugin-bff/effect-client';
export declare const taskPersonQueryFilterSchema: Schema.Union<readonly [Schema.Struct<{
    readonly operator: Schema.Literals<readonly ["contains", "doesNotContain"]>;
    readonly principalId: Schema.String;
}>, Schema.Struct<{
    readonly operator: Schema.Literals<readonly ["isEmpty", "isNotEmpty"]>;
}>]>;
export declare const queryTaskPersonValuesPayloadSchema: Schema.Struct<{
    readonly collectionId: Schema.String;
    readonly filter: Schema.optional<Schema.Union<readonly [Schema.Struct<{
        readonly operator: Schema.Literals<readonly ["contains", "doesNotContain"]>;
        readonly principalId: Schema.String;
    }>, Schema.Struct<{
        readonly operator: Schema.Literals<readonly ["isEmpty", "isNotEmpty"]>;
    }>]>>;
    readonly group: Schema.optional<Schema.Boolean>;
    readonly propertyDefinitionId: Schema.String;
    readonly search: Schema.optional<Schema.String>;
    readonly sort: Schema.optional<Schema.Literals<readonly ["ascending", "descending"]>>;
}>;
export declare const queryTaskPersonValuesResponseSchema: Schema.Struct<{
    readonly groups: Schema.$Array<Schema.Struct<{
        readonly person: Schema.Union<readonly [Schema.Struct<{
            readonly displayName: Schema.String;
            readonly eligible: Schema.Boolean;
            readonly principalId: Schema.String;
            readonly status: Schema.Literals<readonly ["active", "archived", "disabled", "departed"]>;
        }>, Schema.Null]>;
        readonly taskIds: Schema.$Array<Schema.String>;
    }>>;
    readonly taskIds: Schema.$Array<Schema.String>;
}>;
export type QueryTaskPersonValuesPayload = typeof queryTaskPersonValuesPayloadSchema.Type;
export type QueryTaskPersonValuesResponse = typeof queryTaskPersonValuesResponseSchema.Type;
export type TaskPersonQueryFilter = typeof taskPersonQueryFilterSchema.Type;
