import { Schema } from '@modern-js/plugin-bff/effect-client';
export declare const statusQueryOperationSchema: Schema.Union<readonly [Schema.Struct<{
    readonly query: Schema.String;
    readonly type: Schema.Literal<"search">;
}>, Schema.Struct<{
    readonly type: Schema.Literal<"group">;
}>]>;
export type StatusQueryOperation = typeof statusQueryOperationSchema.Type;
