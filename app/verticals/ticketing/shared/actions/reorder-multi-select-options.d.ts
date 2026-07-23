import { Schema } from '@modern-js/plugin-bff/effect-client';
export declare const reorderMultiSelectOptionsActionKey: 'ticketing.reorderMultiSelectOptions';
export declare const reorderMultiSelectOptionsActionPayloadSchema: Schema.Struct<{
    readonly collectionId: Schema.String;
    readonly expectedDefinitionRevision: Schema.Finite;
    readonly optionIds: Schema.$Array<Schema.String>;
    readonly propertyDefinitionId: Schema.String;
}>;
export declare const reorderMultiSelectOptionsActionHeadersSchema: Schema.Struct<{
    readonly 'Idempotency-Key': Schema.optional<Schema.String>;
    readonly 'x-ontos-operation-context': Schema.optional<Schema.String>;
}>;
export declare const reorderMultiSelectOptionsActionResponseSchema: Schema.Struct<{
    readonly definition: Schema.Struct<{
        readonly datatype: Schema.Literal<"multi_select">;
        readonly hidden: Schema.Boolean;
        readonly mandatory: Schema.Boolean;
        readonly name: Schema.String;
        readonly options: Schema.$Array<Schema.Struct<{
            readonly catalogPosition: Schema.Finite;
            readonly color: Schema.String;
            readonly name: Schema.String;
            readonly optionId: Schema.String;
            readonly revision: Schema.Finite;
            readonly updatedAt: Schema.String;
        }>>;
        readonly propertyDefinitionId: Schema.String;
        readonly revision: Schema.Finite;
    }>;
}>;
export declare const reorderMultiSelectOptionsActionOutcomeSchema: Schema.Struct<{
    readonly actionInvocationId: Schema.optional<Schema.String>;
    readonly ok: Schema.Literal<true>;
    readonly response: Schema.Struct<{
        readonly definition: Schema.Struct<{
            readonly datatype: Schema.Literal<"multi_select">;
            readonly hidden: Schema.Boolean;
            readonly mandatory: Schema.Boolean;
            readonly name: Schema.String;
            readonly options: Schema.$Array<Schema.Struct<{
                readonly catalogPosition: Schema.Finite;
                readonly color: Schema.String;
                readonly name: Schema.String;
                readonly optionId: Schema.String;
                readonly revision: Schema.Finite;
                readonly updatedAt: Schema.String;
            }>>;
            readonly propertyDefinitionId: Schema.String;
            readonly revision: Schema.Finite;
        }>;
    }>;
}>;
export declare const reorderMultiSelectOptionsActionFailureSchemas: readonly [Schema.Struct<{
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
export declare const reorderMultiSelectOptionsActionFailureSchema: Schema.Union<readonly [Schema.Struct<{
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
export type ReorderMultiSelectOptionsActionPayload = typeof reorderMultiSelectOptionsActionPayloadSchema.Type;
export type ReorderMultiSelectOptionsActionResponse = typeof reorderMultiSelectOptionsActionResponseSchema.Type;
export type ReorderMultiSelectOptionsActionOutcome = typeof reorderMultiSelectOptionsActionOutcomeSchema.Type;
export type ReorderMultiSelectOptionsActionFailure = typeof reorderMultiSelectOptionsActionFailureSchema.Type;
export declare const reorderMultiSelectOptionsActionTitle: 'Reorder Multi-select Options';
