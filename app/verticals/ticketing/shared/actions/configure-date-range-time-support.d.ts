import { Schema } from '@modern-js/plugin-bff/effect-client';
export declare const configureDateRangeTimeSupportActionKey: 'ticketing.configureDateRangeTimeSupport';
export declare const configureDateRangeTimeSupportActionPayloadSchema: Schema.Struct<{
    readonly collectionId: Schema.String;
    readonly confirmed: Schema.Boolean;
    readonly expectedAffectedValueCount: Schema.Finite;
    readonly expectedRevision: Schema.Finite;
    readonly propertyDefinitionId: Schema.String;
    readonly timeEnabled: Schema.Boolean;
}>;
export declare const configureDateRangeTimeSupportActionHeadersSchema: Schema.Struct<{
    readonly 'Idempotency-Key': Schema.optional<Schema.String>;
    readonly 'x-ontos-operation-context': Schema.optional<Schema.String>;
}>;
export declare const configureDateRangeTimeSupportActionResponseSchema: Schema.Struct<{
    readonly affectedValueCount: Schema.Finite;
    readonly definition: Schema.Struct<{
        readonly datatype: Schema.Literal<"date_range">;
        readonly hidden: Schema.Boolean;
        readonly mandatory: Schema.Boolean;
        readonly name: Schema.String;
        readonly propertyDefinitionId: Schema.String;
        readonly revision: Schema.Finite;
        readonly timeEnabled: Schema.Boolean;
    }>;
}>;
export declare const configureDateRangeTimeSupportActionOutcomeSchema: Schema.Struct<{
    readonly actionInvocationId: Schema.optional<Schema.String>;
    readonly ok: Schema.Literal<true>;
    readonly response: Schema.Struct<{
        readonly affectedValueCount: Schema.Finite;
        readonly definition: Schema.Struct<{
            readonly datatype: Schema.Literal<"date_range">;
            readonly hidden: Schema.Boolean;
            readonly mandatory: Schema.Boolean;
            readonly name: Schema.String;
            readonly propertyDefinitionId: Schema.String;
            readonly revision: Schema.Finite;
            readonly timeEnabled: Schema.Boolean;
        }>;
    }>;
}>;
export declare const configureDateRangeTimeSupportActionFailureSchemas: readonly [Schema.Struct<{
    readonly code: Schema.optional<Schema.String>;
    readonly httpStatus: Schema.Finite;
    readonly message: Schema.String;
    readonly ok: Schema.Literal<false>;
    readonly state: Schema.optional<Schema.Codec<Schema.Json, Schema.Json, never, never>>;
    readonly errorTag: Schema.Literals<readonly ["OperationAuthRequired", "OperationContextInvalid"]>;
}>, Schema.Struct<{
    readonly code: Schema.optional<Schema.String>;
    readonly httpStatus: Schema.Finite;
    readonly message: Schema.String;
    readonly ok: Schema.Literal<false>;
    readonly state: Schema.optional<Schema.Codec<Schema.Json, Schema.Json, never, never>>;
    readonly errorTag: Schema.Literals<readonly ["OperationAuthorizationDenied", "OperationModuleStateDenied"]>;
}>, Schema.Struct<{
    readonly code: Schema.optional<Schema.String>;
    readonly httpStatus: Schema.Finite;
    readonly message: Schema.String;
    readonly ok: Schema.Literal<false>;
    readonly state: Schema.optional<Schema.Codec<Schema.Json, Schema.Json, never, never>>;
    readonly errorTag: Schema.Literals<readonly ["OperationIdempotencyKeyRequired"]>;
}>, Schema.Struct<{
    readonly code: Schema.optional<Schema.String>;
    readonly httpStatus: Schema.Finite;
    readonly message: Schema.String;
    readonly ok: Schema.Literal<false>;
    readonly state: Schema.optional<Schema.Codec<Schema.Json, Schema.Json, never, never>>;
    readonly errorTag: Schema.Literals<readonly ["OperationDomainRejected", "OperationIdempotencyConflict", "OperationIdempotencyReplayUnavailable", "OperationPolicyDenied"]>;
}>, Schema.Struct<{
    readonly code: Schema.optional<Schema.String>;
    readonly httpStatus: Schema.Finite;
    readonly message: Schema.String;
    readonly ok: Schema.Literal<false>;
    readonly state: Schema.optional<Schema.Codec<Schema.Json, Schema.Json, never, never>>;
    readonly errorTag: Schema.Literals<readonly ["OperationExecutionFailed", "OperationPersistenceFailed"]>;
}>];
export declare const configureDateRangeTimeSupportActionFailureSchema: Schema.Union<readonly [Schema.Struct<{
    readonly code: Schema.optional<Schema.String>;
    readonly httpStatus: Schema.Finite;
    readonly message: Schema.String;
    readonly ok: Schema.Literal<false>;
    readonly state: Schema.optional<Schema.Codec<Schema.Json, Schema.Json, never, never>>;
    readonly errorTag: Schema.Literals<readonly ["OperationAuthRequired", "OperationContextInvalid"]>;
}>, Schema.Struct<{
    readonly code: Schema.optional<Schema.String>;
    readonly httpStatus: Schema.Finite;
    readonly message: Schema.String;
    readonly ok: Schema.Literal<false>;
    readonly state: Schema.optional<Schema.Codec<Schema.Json, Schema.Json, never, never>>;
    readonly errorTag: Schema.Literals<readonly ["OperationAuthorizationDenied", "OperationModuleStateDenied"]>;
}>, Schema.Struct<{
    readonly code: Schema.optional<Schema.String>;
    readonly httpStatus: Schema.Finite;
    readonly message: Schema.String;
    readonly ok: Schema.Literal<false>;
    readonly state: Schema.optional<Schema.Codec<Schema.Json, Schema.Json, never, never>>;
    readonly errorTag: Schema.Literals<readonly ["OperationIdempotencyKeyRequired"]>;
}>, Schema.Struct<{
    readonly code: Schema.optional<Schema.String>;
    readonly httpStatus: Schema.Finite;
    readonly message: Schema.String;
    readonly ok: Schema.Literal<false>;
    readonly state: Schema.optional<Schema.Codec<Schema.Json, Schema.Json, never, never>>;
    readonly errorTag: Schema.Literals<readonly ["OperationDomainRejected", "OperationIdempotencyConflict", "OperationIdempotencyReplayUnavailable", "OperationPolicyDenied"]>;
}>, Schema.Struct<{
    readonly code: Schema.optional<Schema.String>;
    readonly httpStatus: Schema.Finite;
    readonly message: Schema.String;
    readonly ok: Schema.Literal<false>;
    readonly state: Schema.optional<Schema.Codec<Schema.Json, Schema.Json, never, never>>;
    readonly errorTag: Schema.Literals<readonly ["OperationExecutionFailed", "OperationPersistenceFailed"]>;
}>]>;
export type ConfigureDateRangeTimeSupportActionPayload = typeof configureDateRangeTimeSupportActionPayloadSchema.Type;
export type ConfigureDateRangeTimeSupportActionResponse = typeof configureDateRangeTimeSupportActionResponseSchema.Type;
export type ConfigureDateRangeTimeSupportActionOutcome = typeof configureDateRangeTimeSupportActionOutcomeSchema.Type;
export type ConfigureDateRangeTimeSupportActionFailure = typeof configureDateRangeTimeSupportActionFailureSchema.Type;
export declare const configureDateRangeTimeSupportActionTitle: 'Configure Date Range Time Support';
