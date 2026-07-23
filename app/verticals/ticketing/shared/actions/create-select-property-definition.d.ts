import { Schema } from '@modern-js/plugin-bff/effect-client';
export declare const createSelectPropertyDefinitionActionKey: 'ticketing.createSelectPropertyDefinition';
export declare const createSelectPropertyDefinitionActionPayloadSchema: Schema.Struct<{
    readonly collectionId: Schema.String;
    readonly mandatory: Schema.Boolean;
    readonly name: Schema.String;
}>;
export declare const createSelectPropertyDefinitionActionHeadersSchema: Schema.Struct<{
    readonly 'Idempotency-Key': Schema.optional<Schema.String>;
    readonly 'x-ontos-operation-context': Schema.optional<Schema.String>;
}>;
export declare const createSelectPropertyDefinitionActionResponseSchema: Schema.Struct<{
    readonly definition: Schema.Struct<{
        readonly datatype: Schema.Literal<"select">;
        readonly hidden: Schema.Boolean;
        readonly mandatory: Schema.Boolean;
        readonly name: Schema.String;
        readonly optionOrderMode: Schema.Literals<readonly ["manual", "alphabetical", "reverse_alphabetical"]>;
        readonly options: Schema.$Array<Schema.Struct<{
            readonly color: Schema.String;
            readonly manualPosition: Schema.Finite;
            readonly name: Schema.String;
            readonly optionId: Schema.String;
            readonly revision: Schema.Finite;
        }>>;
        readonly propertyDefinitionId: Schema.String;
        readonly revision: Schema.Finite;
    }>;
}>;
export declare const createSelectPropertyDefinitionActionOutcomeSchema: Schema.Struct<{
    readonly actionInvocationId: Schema.optional<Schema.String>;
    readonly ok: Schema.Literal<true>;
    readonly response: Schema.Struct<{
        readonly definition: Schema.Struct<{
            readonly datatype: Schema.Literal<"select">;
            readonly hidden: Schema.Boolean;
            readonly mandatory: Schema.Boolean;
            readonly name: Schema.String;
            readonly optionOrderMode: Schema.Literals<readonly ["manual", "alphabetical", "reverse_alphabetical"]>;
            readonly options: Schema.$Array<Schema.Struct<{
                readonly color: Schema.String;
                readonly manualPosition: Schema.Finite;
                readonly name: Schema.String;
                readonly optionId: Schema.String;
                readonly revision: Schema.Finite;
            }>>;
            readonly propertyDefinitionId: Schema.String;
            readonly revision: Schema.Finite;
        }>;
    }>;
}>;
export declare const createSelectPropertyDefinitionActionFailureSchemas: readonly [Schema.Struct<{
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
export declare const createSelectPropertyDefinitionActionFailureSchema: Schema.Union<readonly [Schema.Struct<{
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
export type CreateSelectPropertyDefinitionActionPayload = typeof createSelectPropertyDefinitionActionPayloadSchema.Type;
export type CreateSelectPropertyDefinitionActionResponse = typeof createSelectPropertyDefinitionActionResponseSchema.Type;
export type CreateSelectPropertyDefinitionActionOutcome = typeof createSelectPropertyDefinitionActionOutcomeSchema.Type;
export type CreateSelectPropertyDefinitionActionFailure = typeof createSelectPropertyDefinitionActionFailureSchema.Type;
export declare const createSelectPropertyDefinitionActionTitle: 'Create Select Property Definition';
