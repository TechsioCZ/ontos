import type { Schema } from '@modern-js/plugin-bff/effect-client';

export declare const deleteTaskPropertyDefinitionActionKey: 'ticketing.deleteTaskPropertyDefinition';
export declare const deleteTaskPropertyDefinitionActionPayloadSchema: Schema.Struct<{
  readonly collectionId: Schema.String;
  readonly confirmed: Schema.Literal<true>;
  readonly expectedImpactCount: Schema.Finite;
  readonly expectedRevision: Schema.Finite;
  readonly propertyDefinitionId: Schema.String;
}>;
export declare const deleteTaskPropertyDefinitionActionHeadersSchema: Schema.Struct<{
  readonly 'Idempotency-Key': Schema.optional<Schema.String>;
  readonly 'x-ontos-operation-context': Schema.optional<Schema.String>;
}>;
export declare const deleteTaskPropertyDefinitionActionResponseSchema: Schema.Struct<{
  readonly deletedPropertyDefinitionId: Schema.String;
  readonly impactCount: Schema.Finite;
}>;
export declare const deleteTaskPropertyDefinitionActionOutcomeSchema: Schema.Struct<{
  readonly actionInvocationId: Schema.optional<Schema.String>;
  readonly ok: Schema.Literal<true>;
  readonly response: Schema.Struct<{
    readonly deletedPropertyDefinitionId: Schema.String;
    readonly impactCount: Schema.Finite;
  }>;
}>;
export declare const deleteTaskPropertyDefinitionActionFailureSchemas: readonly [
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
export declare const deleteTaskPropertyDefinitionActionFailureSchema: Schema.Union<
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
export type DeleteTaskPropertyDefinitionActionPayload =
  typeof deleteTaskPropertyDefinitionActionPayloadSchema.Type;
export type DeleteTaskPropertyDefinitionActionResponse =
  typeof deleteTaskPropertyDefinitionActionResponseSchema.Type;
export type DeleteTaskPropertyDefinitionActionOutcome =
  typeof deleteTaskPropertyDefinitionActionOutcomeSchema.Type;
export type DeleteTaskPropertyDefinitionActionFailure =
  typeof deleteTaskPropertyDefinitionActionFailureSchema.Type;
export declare const deleteTaskPropertyDefinitionActionTitle: 'Delete Task Property Definition';
