import type { Schema } from '@modern-js/plugin-bff/effect-client';

export declare const selectQueryOperationSchema: Schema.Union<
  readonly [
    Schema.Struct<{
      readonly operator: Schema.Literals<readonly ['isEmpty', 'isNotEmpty']>;
      readonly type: Schema.Literal<'filter'>;
    }>,
    Schema.Struct<{
      readonly operator: Schema.Literals<readonly ['is', 'isNot']>;
      readonly optionId: Schema.String;
      readonly type: Schema.Literal<'filter'>;
    }>,
  ]
>;
export type SelectQueryOperation = typeof selectQueryOperationSchema.Type;
