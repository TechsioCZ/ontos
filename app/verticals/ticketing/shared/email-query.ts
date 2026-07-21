import { Schema } from '@modern-js/plugin-bff/effect-client';

export const queryTaskEmailValuesPayloadSchema = Schema.Struct({
  collectionId: Schema.String,
  operation: Schema.Literals([
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
  ]),
  propertyDefinitionId: Schema.String,
  query: Schema.String,
});

export const emailQueryGroupSchema = Schema.Struct({
  key: Schema.NullOr(Schema.String),
  label: Schema.NullOr(Schema.String),
  taskIds: Schema.Array(Schema.String),
});

export const queryTaskEmailValuesResponseSchema = Schema.Struct({
  groups: Schema.Array(emailQueryGroupSchema),
  taskIds: Schema.Array(Schema.String),
});

export type QueryTaskEmailValuesPayload = typeof queryTaskEmailValuesPayloadSchema.Type;
export type QueryTaskEmailValuesResponse = typeof queryTaskEmailValuesResponseSchema.Type;
