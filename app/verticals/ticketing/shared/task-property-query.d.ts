import type { Schema } from '@modern-js/plugin-bff/effect-client';

export declare const taskPropertyQuerySchema: Schema.Union<
  readonly [
    Schema.Struct<{
      readonly datatype: Schema.Literal<'text'>;
      readonly operation: Schema.Union<
        readonly [
          Schema.Struct<{
            readonly query: Schema.String;
            readonly type: Schema.Literal<'search'>;
          }>,
          Schema.Struct<{
            readonly operator: Schema.Literals<
              readonly [
                'contains',
                'doesNotContain',
                'equals',
                'doesNotEqual',
                'startsWith',
                'endsWith',
              ]
            >;
            readonly type: Schema.Literal<'filter'>;
            readonly value: Schema.String;
          }>,
          Schema.Struct<{
            readonly operator: Schema.Literals<readonly ['isEmpty', 'isNotEmpty']>;
            readonly type: Schema.Literal<'filter'>;
          }>,
          Schema.Struct<{
            readonly direction: Schema.Literals<readonly ['ascending', 'descending']>;
            readonly type: Schema.Literal<'sort'>;
          }>,
          Schema.Struct<{
            readonly type: Schema.Literal<'group'>;
          }>,
        ]
      >;
    }>,
  ]
>;
export declare const queryTaskPropertyValuesPayloadSchema: Schema.Struct<{
  readonly collectionId: Schema.String;
  readonly propertyDefinitionId: Schema.String;
  readonly query: Schema.Union<
    readonly [
      Schema.Struct<{
        readonly datatype: Schema.Literal<'text'>;
        readonly operation: Schema.Union<
          readonly [
            Schema.Struct<{
              readonly query: Schema.String;
              readonly type: Schema.Literal<'search'>;
            }>,
            Schema.Struct<{
              readonly operator: Schema.Literals<
                readonly [
                  'contains',
                  'doesNotContain',
                  'equals',
                  'doesNotEqual',
                  'startsWith',
                  'endsWith',
                ]
              >;
              readonly type: Schema.Literal<'filter'>;
              readonly value: Schema.String;
            }>,
            Schema.Struct<{
              readonly operator: Schema.Literals<readonly ['isEmpty', 'isNotEmpty']>;
              readonly type: Schema.Literal<'filter'>;
            }>,
            Schema.Struct<{
              readonly direction: Schema.Literals<readonly ['ascending', 'descending']>;
              readonly type: Schema.Literal<'sort'>;
            }>,
            Schema.Struct<{
              readonly type: Schema.Literal<'group'>;
            }>,
          ]
        >;
      }>,
    ]
  >;
}>;
export declare const queryTaskPropertyValuesResponseSchema: Schema.Struct<{
  readonly groups: Schema.optional<
    Schema.$Array<
      Schema.Struct<{
        readonly heading: Schema.Union<readonly [Schema.Null, Schema.String]>;
        readonly taskIds: Schema.$Array<Schema.String>;
      }>
    >
  >;
  readonly taskIds: Schema.$Array<Schema.String>;
}>;
export type TaskPropertyQuery = typeof taskPropertyQuerySchema.Type;
export type QueryTaskPropertyValuesPayload = typeof queryTaskPropertyValuesPayloadSchema.Type;
export type QueryTaskPropertyValuesResponse = typeof queryTaskPropertyValuesResponseSchema.Type;
