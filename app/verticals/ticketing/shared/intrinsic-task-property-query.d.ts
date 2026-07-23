import { Schema } from '@modern-js/plugin-bff/effect-client';
export declare const intrinsicTaskPropertyQueryOperationSchema: Schema.Union<readonly [Schema.TaggedStruct<"CreatedBySearch", {
    readonly value: Schema.String;
}>, Schema.TaggedStruct<"CreatedByFilter", {
    readonly principalId: Schema.String;
}>, Schema.TaggedStruct<"CreatedBySort", {
    readonly direction: Schema.Literals<readonly ["ascending", "descending"]>;
}>, Schema.TaggedStruct<"CreatedByGroup", {}>, Schema.TaggedStruct<"CreatedTimeSearch", {
    readonly value: Schema.String;
}>, Schema.TaggedStruct<"CreatedTimeFilter", {
    readonly endValue: Schema.optional<Schema.String>;
    readonly operator: Schema.Literals<readonly ["exact", "before", "after", "on_or_before", "on_or_after", "local_day", "local_range"]>;
    readonly value: Schema.String;
}>, Schema.TaggedStruct<"CreatedTimeSort", {
    readonly direction: Schema.Literals<readonly ["ascending", "descending"]>;
}>, Schema.TaggedStruct<"CreatedTimeGroup", {}>, Schema.TaggedStruct<"LastEditedTimeSearch", {
    readonly value: Schema.String;
}>, Schema.TaggedStruct<"LastEditedTimeFilter", {
    readonly endValue: Schema.optional<Schema.String>;
    readonly operator: Schema.Literals<readonly ["exact", "before", "after", "on_or_before", "on_or_after", "local_day", "local_range"]>;
    readonly value: Schema.String;
}>, Schema.TaggedStruct<"LastEditedTimeSort", {
    readonly direction: Schema.Literals<readonly ["ascending", "descending"]>;
}>, Schema.TaggedStruct<"LastEditedTimeGroup", {}>]>;
export declare const queryIntrinsicTaskPropertiesPayloadSchema: Schema.Struct<{
    readonly browserTimeZone: Schema.optional<Schema.String>;
    readonly collectionId: Schema.String;
    readonly operation: Schema.Union<readonly [Schema.TaggedStruct<"CreatedBySearch", {
        readonly value: Schema.String;
    }>, Schema.TaggedStruct<"CreatedByFilter", {
        readonly principalId: Schema.String;
    }>, Schema.TaggedStruct<"CreatedBySort", {
        readonly direction: Schema.Literals<readonly ["ascending", "descending"]>;
    }>, Schema.TaggedStruct<"CreatedByGroup", {}>, Schema.TaggedStruct<"CreatedTimeSearch", {
        readonly value: Schema.String;
    }>, Schema.TaggedStruct<"CreatedTimeFilter", {
        readonly endValue: Schema.optional<Schema.String>;
        readonly operator: Schema.Literals<readonly ["exact", "before", "after", "on_or_before", "on_or_after", "local_day", "local_range"]>;
        readonly value: Schema.String;
    }>, Schema.TaggedStruct<"CreatedTimeSort", {
        readonly direction: Schema.Literals<readonly ["ascending", "descending"]>;
    }>, Schema.TaggedStruct<"CreatedTimeGroup", {}>, Schema.TaggedStruct<"LastEditedTimeSearch", {
        readonly value: Schema.String;
    }>, Schema.TaggedStruct<"LastEditedTimeFilter", {
        readonly endValue: Schema.optional<Schema.String>;
        readonly operator: Schema.Literals<readonly ["exact", "before", "after", "on_or_before", "on_or_after", "local_day", "local_range"]>;
        readonly value: Schema.String;
    }>, Schema.TaggedStruct<"LastEditedTimeSort", {
        readonly direction: Schema.Literals<readonly ["ascending", "descending"]>;
    }>, Schema.TaggedStruct<"LastEditedTimeGroup", {}>]>;
    readonly propertyDefinitionId: Schema.String;
    readonly viewerLocale: Schema.String;
}>;
export declare const intrinsicTaskQueryRowSchema: Schema.Struct<{
    readonly createdAt: Schema.optional<Schema.String>;
    readonly createdBy: Schema.optional<Schema.Struct<{
        readonly displayName: Schema.String;
        readonly inactive: Schema.Boolean;
        readonly principalId: Schema.String;
    }>>;
    readonly lastEditedAt: Schema.optional<Schema.String>;
    readonly taskId: Schema.String;
}>;
export declare const queryIntrinsicTaskPropertiesResponseSchema: Schema.Struct<{
    readonly effectiveTimeZone: Schema.optional<Schema.Struct<{
        readonly source: Schema.Literals<readonly ["browser_fallback", "configured", "system_fallback"]>;
        readonly timeZone: Schema.String;
    }>>;
    readonly groups: Schema.$Array<Schema.Struct<{
        readonly key: Schema.String;
        readonly label: Schema.String;
        readonly taskIds: Schema.$Array<Schema.String>;
    }>>;
    readonly tasks: Schema.$Array<Schema.Struct<{
        readonly createdAt: Schema.optional<Schema.String>;
        readonly createdBy: Schema.optional<Schema.Struct<{
            readonly displayName: Schema.String;
            readonly inactive: Schema.Boolean;
            readonly principalId: Schema.String;
        }>>;
        readonly lastEditedAt: Schema.optional<Schema.String>;
        readonly taskId: Schema.String;
    }>>;
}>;
export type IntrinsicTaskPropertyQueryOperation = typeof intrinsicTaskPropertyQueryOperationSchema.Type;
export type QueryIntrinsicTaskPropertiesPayload = typeof queryIntrinsicTaskPropertiesPayloadSchema.Type;
export type QueryIntrinsicTaskPropertiesResponse = typeof queryIntrinsicTaskPropertiesResponseSchema.Type;
