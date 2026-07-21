import type { Schema } from '@modern-js/plugin-bff/effect-client';

export declare const emailQueryOperationSchema: Schema.Literals<
  readonly [
    'search',
    'is',
    'is_not',
    'contains',
    'does_not_contain',
    'is_empty',
    'is_not_empty',
    'sort_ascending',
    'sort_descending',
    'group',
  ]
>;
export declare const queryTaskEmailValuesPayloadSchema: Schema.Struct<{
  readonly collectionId: Schema.String;
  readonly operation: Schema.Literals<
    readonly [
      'search',
      'is',
      'is_not',
      'contains',
      'does_not_contain',
      'is_empty',
      'is_not_empty',
      'sort_ascending',
      'sort_descending',
      'group',
    ]
  >;
  readonly propertyDefinitionId: Schema.String;
  readonly query: Schema.String;
}>;
export declare const emailQueryGroupSchema: Schema.Struct<{
  readonly key: Schema.NullOr<Schema.String>;
  readonly label: Schema.NullOr<Schema.String>;
  readonly taskIds: Schema.$Array<Schema.String>;
}>;
export declare const queryTaskEmailValuesResponseSchema: Schema.Struct<{
  readonly groups: Schema.$Array<
    Schema.Struct<{
      readonly key: Schema.NullOr<Schema.String>;
      readonly label: Schema.NullOr<Schema.String>;
      readonly taskIds: Schema.$Array<Schema.String>;
    }>
  >;
  readonly taskIds: Schema.$Array<Schema.String>;
}>;
export type QueryTaskEmailValuesPayload = typeof queryTaskEmailValuesPayloadSchema.Type;
export type QueryTaskEmailValuesResponse = typeof queryTaskEmailValuesResponseSchema.Type;
