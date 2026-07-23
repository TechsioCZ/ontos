import { Schema } from '@modern-js/plugin-bff/effect-client';
export declare const textSearchOperationSchema: Schema.Struct<{
    readonly query: Schema.String;
    readonly type: Schema.Literal<"search">;
}>;
export declare const textValueFilterOperationSchema: Schema.Struct<{
    readonly operator: Schema.Literals<readonly ["contains", "doesNotContain", "equals", "doesNotEqual", "startsWith", "endsWith"]>;
    readonly type: Schema.Literal<"filter">;
    readonly value: Schema.String;
}>;
export declare const textEmptyFilterOperationSchema: Schema.Struct<{
    readonly operator: Schema.Literals<readonly ["isEmpty", "isNotEmpty"]>;
    readonly type: Schema.Literal<"filter">;
}>;
export declare const textSortOperationSchema: Schema.Struct<{
    readonly direction: Schema.Literals<readonly ["ascending", "descending"]>;
    readonly type: Schema.Literal<"sort">;
}>;
export declare const textGroupOperationSchema: Schema.Struct<{
    readonly type: Schema.Literal<"group">;
}>;
export declare const textQueryOperationSchema: Schema.Union<readonly [Schema.Struct<{
    readonly query: Schema.String;
    readonly type: Schema.Literal<"search">;
}>, Schema.Struct<{
    readonly operator: Schema.Literals<readonly ["contains", "doesNotContain", "equals", "doesNotEqual", "startsWith", "endsWith"]>;
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
export type TextQueryOperation = typeof textQueryOperationSchema.Type;
