import { Schema } from '@modern-js/plugin-bff/effect-client';
export declare const taskUrlQueryOperationSchema: Schema.Union<readonly [Schema.Struct<{
    readonly kind: Schema.Literal<"search">;
    readonly query: Schema.String;
}>, Schema.Struct<{
    readonly kind: Schema.Literal<"filter">;
    readonly operator: Schema.Literals<readonly ["contains", "does_not_contain"]>;
    readonly query: Schema.String;
}>, Schema.Struct<{
    readonly kind: Schema.Literal<"filter">;
    readonly operator: Schema.Literals<readonly ["is_empty", "is_not_empty"]>;
}>, Schema.Struct<{
    readonly direction: Schema.Literals<readonly ["ascending", "descending"]>;
    readonly kind: Schema.Literal<"sort">;
}>, Schema.Struct<{
    readonly kind: Schema.Literal<"group">;
}>]>;
export declare const queryTaskUrlValuesPayloadSchema: Schema.Struct<{
    readonly collectionId: Schema.String;
    readonly operation: Schema.Union<readonly [Schema.Struct<{
        readonly kind: Schema.Literal<"search">;
        readonly query: Schema.String;
    }>, Schema.Struct<{
        readonly kind: Schema.Literal<"filter">;
        readonly operator: Schema.Literals<readonly ["contains", "does_not_contain"]>;
        readonly query: Schema.String;
    }>, Schema.Struct<{
        readonly kind: Schema.Literal<"filter">;
        readonly operator: Schema.Literals<readonly ["is_empty", "is_not_empty"]>;
    }>, Schema.Struct<{
        readonly direction: Schema.Literals<readonly ["ascending", "descending"]>;
        readonly kind: Schema.Literal<"sort">;
    }>, Schema.Struct<{
        readonly kind: Schema.Literal<"group">;
    }>]>;
    readonly propertyDefinitionId: Schema.String;
}>;
export declare const urlValueGroupSchema: Schema.Struct<{
    readonly heading: Schema.NullOr<Schema.String>;
    readonly taskIds: Schema.$Array<Schema.String>;
}>;
export declare const queryTaskUrlValuesResponseSchema: Schema.Struct<{
    readonly groups: Schema.$Array<Schema.Struct<{
        readonly heading: Schema.NullOr<Schema.String>;
        readonly taskIds: Schema.$Array<Schema.String>;
    }>>;
    readonly taskIds: Schema.$Array<Schema.String>;
}>;
export type QueryTaskUrlValuesPayload = typeof queryTaskUrlValuesPayloadSchema.Type;
export type QueryTaskUrlValuesResponse = typeof queryTaskUrlValuesResponseSchema.Type;
