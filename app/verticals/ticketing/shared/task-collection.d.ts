import { Schema } from '@modern-js/plugin-bff/effect-client';
export declare const taskPropertyDefinitionSchema: Schema.Struct<{
    readonly datatype: Schema.Literal<"title">;
    readonly mandatory: Schema.Boolean;
    readonly name: Schema.String;
    readonly propertyDefinitionId: Schema.String;
}>;
export declare const taskCollectionRecordSchema: Schema.Struct<{
    readonly collectionId: Schema.String;
    readonly createdAt: Schema.String;
    readonly name: Schema.String;
    readonly schemaId: Schema.String;
}>;
export declare const taskCollectionSchemaRecordSchema: Schema.Struct<{
    readonly collectionId: Schema.String;
    readonly propertyDefinitions: Schema.$Array<Schema.Struct<{
        readonly datatype: Schema.Literal<"title">;
        readonly mandatory: Schema.Boolean;
        readonly name: Schema.String;
        readonly propertyDefinitionId: Schema.String;
    }>>;
    readonly schemaId: Schema.String;
}>;
export declare const taskRecordSchema: Schema.Struct<{
    readonly canvas: Schema.Codec<Schema.Json, Schema.Json, never, never>;
    readonly collectionId: Schema.String;
    readonly createdAt: Schema.String;
    readonly createdByPrincipalId: Schema.String;
    readonly lastEditedAt: Schema.String;
    readonly lastEditedByPrincipalId: Schema.String;
    readonly revision: Schema.Finite;
    readonly taskId: Schema.String;
    readonly title: Schema.String;
}>;
export declare const taskCollectionCreationSchema: Schema.Struct<{
    readonly collection: Schema.Struct<{
        readonly collectionId: Schema.String;
        readonly createdAt: Schema.String;
        readonly name: Schema.String;
        readonly schemaId: Schema.String;
    }>;
    readonly schema: Schema.Struct<{
        readonly collectionId: Schema.String;
        readonly propertyDefinitions: Schema.$Array<Schema.Struct<{
            readonly datatype: Schema.Literal<"title">;
            readonly mandatory: Schema.Boolean;
            readonly name: Schema.String;
            readonly propertyDefinitionId: Schema.String;
        }>>;
        readonly schemaId: Schema.String;
    }>;
}>;
export declare const taskCreationSchema: Schema.Struct<{
    readonly task: Schema.Struct<{
        readonly canvas: Schema.Codec<Schema.Json, Schema.Json, never, never>;
        readonly collectionId: Schema.String;
        readonly createdAt: Schema.String;
        readonly createdByPrincipalId: Schema.String;
        readonly lastEditedAt: Schema.String;
        readonly lastEditedByPrincipalId: Schema.String;
        readonly revision: Schema.Finite;
        readonly taskId: Schema.String;
        readonly title: Schema.String;
    }>;
}>;
export declare const taskCollectionAggregateSchema: Schema.Struct<{
    readonly collection: Schema.Struct<{
        readonly collectionId: Schema.String;
        readonly createdAt: Schema.String;
        readonly name: Schema.String;
        readonly schemaId: Schema.String;
    }>;
    readonly schema: Schema.Struct<{
        readonly collectionId: Schema.String;
        readonly propertyDefinitions: Schema.$Array<Schema.Struct<{
            readonly datatype: Schema.Literal<"title">;
            readonly mandatory: Schema.Boolean;
            readonly name: Schema.String;
            readonly propertyDefinitionId: Schema.String;
        }>>;
        readonly schemaId: Schema.String;
    }>;
    readonly task: Schema.Struct<{
        readonly canvas: Schema.Codec<Schema.Json, Schema.Json, never, never>;
        readonly collectionId: Schema.String;
        readonly createdAt: Schema.String;
        readonly createdByPrincipalId: Schema.String;
        readonly lastEditedAt: Schema.String;
        readonly lastEditedByPrincipalId: Schema.String;
        readonly revision: Schema.Finite;
        readonly taskId: Schema.String;
        readonly title: Schema.String;
    }>;
}>;
export declare const getTaskCollectionPayloadSchema: Schema.Struct<{
    readonly collectionId: Schema.String;
}>;
export type TaskCollectionAggregate = typeof taskCollectionAggregateSchema.Type;
export type TaskCollectionCreation = typeof taskCollectionCreationSchema.Type;
export type TaskCreation = typeof taskCreationSchema.Type;
export type GetTaskCollectionPayload = typeof getTaskCollectionPayloadSchema.Type;
