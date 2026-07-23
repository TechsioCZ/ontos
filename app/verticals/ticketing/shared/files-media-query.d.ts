import { Schema } from '@modern-js/plugin-bff/effect-client';
export declare const filesMediaQueryOperationSchema: Schema.Union<readonly [Schema.Struct<{
    readonly query: Schema.String;
    readonly type: Schema.Literal<"search">;
}>, Schema.Struct<{
    readonly operator: Schema.Literals<readonly ["contains", "doesNotContain"]>;
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
export type FilesMediaQueryOperation = typeof filesMediaQueryOperationSchema.Type;
