import { Schema } from '@modern-js/plugin-bff/effect-client';
export declare const multiSelectQueryOperationSchema: Schema.Union<readonly [Schema.Struct<{
    readonly query: Schema.String;
    readonly type: Schema.Literal<"search">;
}>, Schema.Struct<{
    readonly operator: Schema.Literals<readonly ["contains", "doesNotContain"]>;
    readonly optionId: Schema.String;
    readonly type: Schema.Literal<"filter">;
}>, Schema.Struct<{
    readonly operator: Schema.Literals<readonly ["isEmpty", "isNotEmpty"]>;
    readonly type: Schema.Literal<"filter">;
}>]>;
export type MultiSelectQueryOperation = typeof multiSelectQueryOperationSchema.Type;
