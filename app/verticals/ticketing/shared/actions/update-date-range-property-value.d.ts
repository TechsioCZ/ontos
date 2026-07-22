import type { Schema } from '@modern-js/plugin-bff/effect-client';

export declare const updateDateRangePropertyValueActionKey: 'ticketing.updateDateRangePropertyValue';
export declare const updateDateRangePropertyValueActionPayloadSchema: Schema.Struct<{
  readonly collectionId: Schema.String;
  readonly expectedRevision: Schema.Finite;
  readonly propertyDefinitionId: Schema.String;
  readonly taskId: Schema.String;
  readonly value: Schema.NullOr<
    Schema.Struct<{
      readonly endDate: Schema.String;
      readonly endTime: Schema.NullOr<Schema.String>;
      readonly startDate: Schema.String;
      readonly startTime: Schema.NullOr<Schema.String>;
    }>
  >;
}>;
export declare const updateDateRangePropertyValueActionHeadersSchema: Schema.Struct<{
  readonly 'Idempotency-Key': Schema.optional<Schema.String>;
  readonly 'x-ontos-operation-context': Schema.optional<Schema.String>;
}>;
export declare const updateDateRangePropertyValueActionResponseSchema: Schema.Struct<{
  readonly taskRevision: Schema.Finite;
  readonly value: Schema.NullOr<
    Schema.Struct<{
      readonly propertyDefinitionId: Schema.String;
      readonly revision: Schema.Finite;
      readonly value: Schema.NullOr<
        Schema.Struct<{
          readonly endDate: Schema.String;
          readonly endTime: Schema.NullOr<Schema.String>;
          readonly startDate: Schema.String;
          readonly startTime: Schema.NullOr<Schema.String>;
        }>
      >;
    }>
  >;
}>;
export declare const updateDateRangePropertyValueActionOutcomeSchema: Schema.Struct<{
  readonly actionInvocationId: Schema.optional<Schema.String>;
  readonly ok: Schema.Literal<true>;
  readonly response: Schema.Struct<{
    readonly taskRevision: Schema.Finite;
    readonly value: Schema.NullOr<
      Schema.Struct<{
        readonly propertyDefinitionId: Schema.String;
        readonly revision: Schema.Finite;
        readonly value: Schema.NullOr<
          Schema.Struct<{
            readonly endDate: Schema.String;
            readonly endTime: Schema.NullOr<Schema.String>;
            readonly startDate: Schema.String;
            readonly startTime: Schema.NullOr<Schema.String>;
          }>
        >;
      }>
    >;
  }>;
}>;
export declare const updateDateRangePropertyValueActionFailureSchemas: readonly [
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
export declare const updateDateRangePropertyValueActionFailureSchema: Schema.Union<
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
export type UpdateDateRangePropertyValueActionPayload =
  typeof updateDateRangePropertyValueActionPayloadSchema.Type;
export type UpdateDateRangePropertyValueActionResponse =
  typeof updateDateRangePropertyValueActionResponseSchema.Type;
export type UpdateDateRangePropertyValueActionOutcome =
  typeof updateDateRangePropertyValueActionOutcomeSchema.Type;
export type UpdateDateRangePropertyValueActionFailure =
  typeof updateDateRangePropertyValueActionFailureSchema.Type;
export declare const updateDateRangePropertyValueActionTitle: 'Update Date Range Property Value';
