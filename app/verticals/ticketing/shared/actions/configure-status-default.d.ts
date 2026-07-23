import { Schema } from '@modern-js/plugin-bff/effect-client';
export declare const configureStatusDefaultActionKey: 'ticketing.configureStatusDefault';
export declare const configureStatusDefaultActionPayloadSchema: Schema.Struct<{
    readonly collectionId: Schema.String;
    readonly expectedDefinitionRevision: Schema.Finite;
    readonly optionId: Schema.String;
    readonly propertyDefinitionId: Schema.String;
}>;
export declare const configureStatusDefaultActionHeadersSchema: Schema.Struct<{
    readonly 'Idempotency-Key': Schema.optional<Schema.String>;
    readonly 'x-ontos-operation-context': Schema.optional<Schema.String>;
}>;
export declare const configureStatusDefaultActionResponseSchema: Schema.Struct<{
    readonly definition: Schema.Struct<{
        readonly datatype: Schema.Literal<"status">;
        readonly defaultOptionId: Schema.String;
        readonly groups: Schema.$Array<Schema.Struct<{
            readonly group: Schema.Literals<readonly ["todo", "in_progress", "complete"]>;
            readonly label: Schema.String;
            readonly options: Schema.$Array<Schema.Struct<{
                readonly color: Schema.String;
                readonly group: Schema.Literals<readonly ["todo", "in_progress", "complete"]>;
                readonly name: Schema.String;
                readonly optionId: Schema.String;
                readonly position: Schema.Finite;
                readonly revision: Schema.Finite;
            }>>;
        }>>;
        readonly hidden: Schema.Boolean;
        readonly mandatory: Schema.Boolean;
        readonly name: Schema.String;
        readonly propertyDefinitionId: Schema.String;
        readonly revision: Schema.Finite;
    }>;
}>;
export declare const configureStatusDefaultActionOutcomeSchema: Schema.Struct<{
    readonly actionInvocationId: Schema.optional<Schema.String>;
    readonly ok: Schema.Literal<true>;
    readonly response: Schema.Struct<{
        readonly definition: Schema.Struct<{
            readonly datatype: Schema.Literal<"status">;
            readonly defaultOptionId: Schema.String;
            readonly groups: Schema.$Array<Schema.Struct<{
                readonly group: Schema.Literals<readonly ["todo", "in_progress", "complete"]>;
                readonly label: Schema.String;
                readonly options: Schema.$Array<Schema.Struct<{
                    readonly color: Schema.String;
                    readonly group: Schema.Literals<readonly ["todo", "in_progress", "complete"]>;
                    readonly name: Schema.String;
                    readonly optionId: Schema.String;
                    readonly position: Schema.Finite;
                    readonly revision: Schema.Finite;
                }>>;
            }>>;
            readonly hidden: Schema.Boolean;
            readonly mandatory: Schema.Boolean;
            readonly name: Schema.String;
            readonly propertyDefinitionId: Schema.String;
            readonly revision: Schema.Finite;
        }>;
    }>;
}>;
export declare const configureStatusDefaultActionFailureSchemas: readonly [Schema.Struct<{
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
export declare const configureStatusDefaultActionFailureSchema: Schema.Union<readonly [Schema.Struct<{
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
export type ConfigureStatusDefaultActionPayload = typeof configureStatusDefaultActionPayloadSchema.Type;
export type ConfigureStatusDefaultActionResponse = typeof configureStatusDefaultActionResponseSchema.Type;
export type ConfigureStatusDefaultActionOutcome = typeof configureStatusDefaultActionOutcomeSchema.Type;
export type ConfigureStatusDefaultActionFailure = typeof configureStatusDefaultActionFailureSchema.Type;
export declare const configureStatusDefaultActionTitle: 'Configure Status Default';
