import type { Schema } from '@modern-js/plugin-bff/effect-client';
import type { TaskCollectionAggregate } from '../task-collection.ts';

export declare const createTicketActionKey: 'ticketing.createTicket';
export declare const createTicketActionPayloadSchema: Schema.Struct<{
  readonly collectionId: Schema.String;
}>;
export declare const createTicketActionHeadersSchema: Schema.Struct<{
  readonly 'Idempotency-Key': Schema.optional<Schema.String>;
  readonly 'x-ontos-operation-context': Schema.optional<Schema.String>;
}>;
export declare const createTicketActionResponseSchema: Schema.Struct<{
  readonly collection: Schema.Struct<{
    readonly collectionId: Schema.String;
    readonly createdAt: Schema.String;
    readonly schemaId: Schema.String;
  }>;
  readonly schema: Schema.Struct<{
    readonly collectionId: Schema.String;
    readonly propertyDefinitions: Schema.$Array<
      Schema.Struct<{
        readonly datatype: Schema.Literal<'title'>;
        readonly mandatory: Schema.Boolean;
        readonly name: Schema.String;
        readonly propertyDefinitionId: Schema.String;
      }>
    >;
    readonly schemaId: Schema.String;
  }>;
  readonly task: Schema.Struct<{
    readonly collectionId: Schema.String;
    readonly createdAt: Schema.String;
    readonly createdByPrincipalId: Schema.String;
    readonly lastEditedAt: Schema.String;
    readonly lastEditedByPrincipalId: Schema.String;
    readonly revision: Schema.Finite;
    readonly taskId: Schema.String;
    readonly title: Schema.String;
  }>;
}>;
export declare const createTicketActionOutcomeSchema: Schema.Struct<{
  readonly actionInvocationId: Schema.optional<Schema.String>;
  readonly ok: Schema.Literal<true>;
  readonly response: Schema.Struct<{
    readonly collection: Schema.Struct<{
      readonly collectionId: Schema.String;
      readonly createdAt: Schema.String;
      readonly schemaId: Schema.String;
    }>;
    readonly schema: Schema.Struct<{
      readonly collectionId: Schema.String;
      readonly propertyDefinitions: Schema.$Array<
        Schema.Struct<{
          readonly datatype: Schema.Literal<'title'>;
          readonly mandatory: Schema.Boolean;
          readonly name: Schema.String;
          readonly propertyDefinitionId: Schema.String;
        }>
      >;
      readonly schemaId: Schema.String;
    }>;
    readonly task: Schema.Struct<{
      readonly collectionId: Schema.String;
      readonly createdAt: Schema.String;
      readonly createdByPrincipalId: Schema.String;
      readonly lastEditedAt: Schema.String;
      readonly lastEditedByPrincipalId: Schema.String;
      readonly revision: Schema.Finite;
      readonly taskId: Schema.String;
      readonly title: Schema.String;
    }>;
  }>;
}>;
export declare const createTicketActionFailureSchema: Schema.Struct<{
  readonly code: Schema.optional<Schema.String>;
  readonly errorTag: Schema.String;
  readonly httpStatus: Schema.Finite;
  readonly message: Schema.String;
  readonly ok: Schema.Literal<false>;
  readonly state: Schema.optional<Schema.Codec<Schema.Json, Schema.Json, never, never>>;
}>;
export type CreateTicketActionPayload = typeof createTicketActionPayloadSchema.Type;
export type CreateTicketActionResponse = TaskCollectionAggregate;
export type CreateTicketActionOutcome = typeof createTicketActionOutcomeSchema.Type;
export type CreateTicketActionFailure = typeof createTicketActionFailureSchema.Type;
export declare const createTicketActionTitle: 'Create Task Collection';
