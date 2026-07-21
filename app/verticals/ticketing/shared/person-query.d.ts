// oxlint-disable typescript/consistent-type-imports, import/newline-after-import -- TypeScript-generated query declaration
import { Schema } from '@modern-js/plugin-bff/effect-client';
export declare const queryTaskPersonValuesPayloadSchema: Schema.Struct<{
  readonly collectionId: Schema.String;
  readonly filter: Schema.optional<
    Schema.Literals<readonly ['contains', 'doesNotContain', 'isEmpty', 'isNotEmpty']>
  >;
  readonly group: Schema.optional<Schema.Boolean>;
  readonly principalId: Schema.optional<Schema.String>;
  readonly propertyDefinitionId: Schema.String;
  readonly search: Schema.optional<Schema.String>;
  readonly sort: Schema.optional<Schema.Literals<readonly ['ascending', 'descending']>>;
}>;
export declare const queryTaskPersonValuesResponseSchema: Schema.Struct<{
  readonly groups: Schema.$Array<
    Schema.Struct<{
      readonly person: Schema.Union<
        readonly [
          Schema.Struct<{
            readonly displayName: Schema.String;
            readonly eligible: Schema.Boolean;
            readonly principalId: Schema.String;
            readonly status: Schema.Literals<
              readonly ['active', 'archived', 'disabled', 'departed']
            >;
          }>,
          Schema.Null,
        ]
      >;
      readonly taskIds: Schema.$Array<Schema.String>;
    }>
  >;
  readonly taskIds: Schema.$Array<Schema.String>;
}>;
export type QueryTaskPersonValuesPayload = typeof queryTaskPersonValuesPayloadSchema.Type;
export type QueryTaskPersonValuesResponse = typeof queryTaskPersonValuesResponseSchema.Type;
