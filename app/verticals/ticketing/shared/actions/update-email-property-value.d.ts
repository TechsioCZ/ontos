import type { Schema } from '@modern-js/plugin-bff/effect-client';

export declare const updateEmailPropertyValueActionKey: 'ticketing.updateEmailPropertyValue';
export declare const updateEmailPropertyValueActionPayloadSchema: Schema.Struct<{
  readonly collectionId: Schema.String;
  readonly expectedRevision: Schema.Finite;
  readonly propertyDefinitionId: Schema.String;
  readonly taskId: Schema.String;
  readonly value: Schema.String;
}>;
export declare const updateEmailPropertyValueActionHeadersSchema: Schema.Struct<{
  readonly 'Idempotency-Key': Schema.optional<Schema.String>;
  readonly 'x-ontos-operation-context': Schema.optional<Schema.String>;
}>;
export declare const updateEmailPropertyValueActionResponseSchema: Schema.Struct<{
  readonly taskRevision: Schema.Finite;
  readonly value: Schema.Struct<{
    readonly propertyDefinitionId: Schema.String;
    readonly revision: Schema.Finite;
    readonly value: Schema.NullOr<Schema.String>;
  }>;
}>;
export declare const updateEmailPropertyValueActionOutcomeSchema: Schema.Struct<{
  readonly actionInvocationId: Schema.optional<Schema.String>;
  readonly ok: Schema.Literal<true>;
  readonly response: Schema.Struct<{
    readonly taskRevision: Schema.Finite;
    readonly value: Schema.Struct<{
      readonly propertyDefinitionId: Schema.String;
      readonly revision: Schema.Finite;
      readonly value: Schema.NullOr<Schema.String>;
    }>;
  }>;
}>;
export declare const updateEmailPropertyValueActionFailureSchemas: readonly [
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
export declare const updateEmailPropertyValueActionFailureSchema: Schema.Union<
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
export type UpdateEmailPropertyValueActionPayload =
  typeof updateEmailPropertyValueActionPayloadSchema.Type;
export type UpdateEmailPropertyValueActionResponse =
  typeof updateEmailPropertyValueActionResponseSchema.Type;
export type UpdateEmailPropertyValueActionOutcome =
  typeof updateEmailPropertyValueActionOutcomeSchema.Type;
export type UpdateEmailPropertyValueActionFailure =
  typeof updateEmailPropertyValueActionFailureSchema.Type;
export declare const updateEmailPropertyValueActionTitle: 'Update Email Property Value';
