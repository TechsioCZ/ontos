import type { Schema } from '@modern-js/plugin-bff/effect-client';

export declare const createFilesMediaPropertyDefinitionActionKey: 'ticketing.createFilesMediaPropertyDefinition';
export declare const createFilesMediaPropertyDefinitionActionPayloadSchema: Schema.Struct<{
  readonly collectionId: Schema.String;
  readonly mandatory: Schema.Boolean;
  readonly name: Schema.String;
}>;
export declare const createFilesMediaPropertyDefinitionActionHeadersSchema: Schema.Struct<{
  readonly 'Idempotency-Key': Schema.optional<Schema.String>;
  readonly 'x-ontos-operation-context': Schema.optional<Schema.String>;
}>;
export declare const createFilesMediaPropertyDefinitionActionResponseSchema: Schema.Struct<{
  readonly definition: Schema.Struct<{
    readonly datatype: Schema.Literal<'files_media'>;
    readonly hidden: Schema.Boolean;
    readonly mandatory: Schema.Boolean;
    readonly name: Schema.String;
    readonly propertyDefinitionId: Schema.String;
    readonly revision: Schema.Finite;
  }>;
}>;
export declare const createFilesMediaPropertyDefinitionActionOutcomeSchema: Schema.Struct<{
  readonly actionInvocationId: Schema.optional<Schema.String>;
  readonly ok: Schema.Literal<true>;
  readonly response: Schema.Struct<{
    readonly definition: Schema.Struct<{
      readonly datatype: Schema.Literal<'files_media'>;
      readonly hidden: Schema.Boolean;
      readonly mandatory: Schema.Boolean;
      readonly name: Schema.String;
      readonly propertyDefinitionId: Schema.String;
      readonly revision: Schema.Finite;
    }>;
  }>;
}>;
export declare const createFilesMediaPropertyDefinitionActionFailureSchemas: readonly [
  Schema.Struct<{
    readonly code: Schema.optional<Schema.String>;
    readonly httpStatus: Schema.Finite;
    readonly message: Schema.String;
    readonly ok: Schema.Literal<false>;
    readonly state: Schema.optional<Schema.Codec<Schema.Json, Schema.Json, never, never>>;
    readonly errorTag: Schema.Literals<
      readonly ['OperationAuthRequired', 'OperationContextInvalid']
    >;
  }>,
  Schema.Struct<{
    readonly code: Schema.optional<Schema.String>;
    readonly httpStatus: Schema.Finite;
    readonly message: Schema.String;
    readonly ok: Schema.Literal<false>;
    readonly state: Schema.optional<Schema.Codec<Schema.Json, Schema.Json, never, never>>;
    readonly errorTag: Schema.Literals<
      readonly ['OperationAuthorizationDenied', 'OperationModuleStateDenied']
    >;
  }>,
  Schema.Struct<{
    readonly code: Schema.optional<Schema.String>;
    readonly httpStatus: Schema.Finite;
    readonly message: Schema.String;
    readonly ok: Schema.Literal<false>;
    readonly state: Schema.optional<Schema.Codec<Schema.Json, Schema.Json, never, never>>;
    readonly errorTag: Schema.Literals<readonly ['OperationIdempotencyKeyRequired']>;
  }>,
  Schema.Struct<{
    readonly code: Schema.optional<Schema.String>;
    readonly httpStatus: Schema.Finite;
    readonly message: Schema.String;
    readonly ok: Schema.Literal<false>;
    readonly state: Schema.optional<Schema.Codec<Schema.Json, Schema.Json, never, never>>;
    readonly errorTag: Schema.Literals<
      readonly [
        'OperationDomainRejected',
        'OperationIdempotencyConflict',
        'OperationIdempotencyReplayUnavailable',
        'OperationPolicyDenied',
      ]
    >;
  }>,
  Schema.Struct<{
    readonly code: Schema.optional<Schema.String>;
    readonly httpStatus: Schema.Finite;
    readonly message: Schema.String;
    readonly ok: Schema.Literal<false>;
    readonly state: Schema.optional<Schema.Codec<Schema.Json, Schema.Json, never, never>>;
    readonly errorTag: Schema.Literals<
      readonly ['OperationExecutionFailed', 'OperationPersistenceFailed']
    >;
  }>,
];
export declare const createFilesMediaPropertyDefinitionActionFailureSchema: Schema.Union<
  readonly [
    Schema.Struct<{
      readonly code: Schema.optional<Schema.String>;
      readonly httpStatus: Schema.Finite;
      readonly message: Schema.String;
      readonly ok: Schema.Literal<false>;
      readonly state: Schema.optional<Schema.Codec<Schema.Json, Schema.Json, never, never>>;
      readonly errorTag: Schema.Literals<
        readonly ['OperationAuthRequired', 'OperationContextInvalid']
      >;
    }>,
    Schema.Struct<{
      readonly code: Schema.optional<Schema.String>;
      readonly httpStatus: Schema.Finite;
      readonly message: Schema.String;
      readonly ok: Schema.Literal<false>;
      readonly state: Schema.optional<Schema.Codec<Schema.Json, Schema.Json, never, never>>;
      readonly errorTag: Schema.Literals<
        readonly ['OperationAuthorizationDenied', 'OperationModuleStateDenied']
      >;
    }>,
    Schema.Struct<{
      readonly code: Schema.optional<Schema.String>;
      readonly httpStatus: Schema.Finite;
      readonly message: Schema.String;
      readonly ok: Schema.Literal<false>;
      readonly state: Schema.optional<Schema.Codec<Schema.Json, Schema.Json, never, never>>;
      readonly errorTag: Schema.Literals<readonly ['OperationIdempotencyKeyRequired']>;
    }>,
    Schema.Struct<{
      readonly code: Schema.optional<Schema.String>;
      readonly httpStatus: Schema.Finite;
      readonly message: Schema.String;
      readonly ok: Schema.Literal<false>;
      readonly state: Schema.optional<Schema.Codec<Schema.Json, Schema.Json, never, never>>;
      readonly errorTag: Schema.Literals<
        readonly [
          'OperationDomainRejected',
          'OperationIdempotencyConflict',
          'OperationIdempotencyReplayUnavailable',
          'OperationPolicyDenied',
        ]
      >;
    }>,
    Schema.Struct<{
      readonly code: Schema.optional<Schema.String>;
      readonly httpStatus: Schema.Finite;
      readonly message: Schema.String;
      readonly ok: Schema.Literal<false>;
      readonly state: Schema.optional<Schema.Codec<Schema.Json, Schema.Json, never, never>>;
      readonly errorTag: Schema.Literals<
        readonly ['OperationExecutionFailed', 'OperationPersistenceFailed']
      >;
    }>,
  ]
>;
export type CreateFilesMediaPropertyDefinitionActionPayload =
  typeof createFilesMediaPropertyDefinitionActionPayloadSchema.Type;
export type CreateFilesMediaPropertyDefinitionActionResponse =
  typeof createFilesMediaPropertyDefinitionActionResponseSchema.Type;
export type CreateFilesMediaPropertyDefinitionActionOutcome =
  typeof createFilesMediaPropertyDefinitionActionOutcomeSchema.Type;
export type CreateFilesMediaPropertyDefinitionActionFailure =
  typeof createFilesMediaPropertyDefinitionActionFailureSchema.Type;
