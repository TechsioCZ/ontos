import { Schema } from '@modern-js/plugin-bff/effect-client';
export declare const numberSearchOperationSchema: Schema.Struct<{
    readonly query: Schema.String;
    readonly type: Schema.Literal<"search">;
}>;
export declare const numberValueFilterOperationSchema: Schema.Struct<{
    readonly operator: Schema.Literals<readonly ["equal", "notEqual", "greaterThan", "lessThan", "greaterThanOrEqual", "lessThanOrEqual"]>;
    readonly type: Schema.Literal<"filter">;
    readonly value: Schema.String;
}>;
export declare const numberEmptyFilterOperationSchema: Schema.Struct<{
    readonly operator: Schema.Literals<readonly ["isEmpty", "isNotEmpty"]>;
    readonly type: Schema.Literal<"filter">;
}>;
export declare const numberSortOperationSchema: Schema.Struct<{
    readonly direction: Schema.Literals<readonly ["ascending", "descending"]>;
    readonly type: Schema.Literal<"sort">;
}>;
export declare const numberGroupOperationSchema: Schema.Struct<{
    readonly type: Schema.Literal<"group">;
}>;
export declare const numberQueryOperationSchema: Schema.Union<readonly [Schema.Struct<{
    readonly query: Schema.String;
    readonly type: Schema.Literal<"search">;
}>, Schema.Struct<{
    readonly operator: Schema.Literals<readonly ["equal", "notEqual", "greaterThan", "lessThan", "greaterThanOrEqual", "lessThanOrEqual"]>;
    readonly type: Schema.Literal<"filter">;
    readonly value: Schema.String;
}>, Schema.Struct<{
    readonly operator: Schema.Literals<readonly ["isEmpty", "isNotEmpty"]>;
    readonly type: Schema.Literal<"filter">;
}>, Schema.Struct<{
    readonly direction: Schema.Literals<readonly ["ascending", "descending"]>;
    readonly type: Schema.Literal<"sort">;
}>, Schema.Struct<{
    readonly type: Schema.Literal<"group">;
}>]>;
export type NumberQueryOperation = typeof numberQueryOperationSchema.Type;
