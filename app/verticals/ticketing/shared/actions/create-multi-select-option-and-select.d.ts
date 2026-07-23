import { Schema } from '@modern-js/plugin-bff/effect-client';
export declare const createMultiSelectOptionAndSelectActionKey: 'ticketing.createMultiSelectOptionAndSelect';
export declare const createMultiSelectOptionAndSelectActionPayloadSchema: Schema.Struct<{
    readonly collectionId: Schema.String;
    readonly color: Schema.String;
    readonly expectedDefinitionRevision: Schema.Finite;
    readonly expectedValueRevision: Schema.Finite;
    readonly name: Schema.String;
    readonly propertyDefinitionId: Schema.String;
    readonly taskId: Schema.String;
}>;
export declare const createMultiSelectOptionAndSelectActionHeadersSchema: Schema.Struct<{
    readonly 'Idempotency-Key': Schema.optional<Schema.String>;
    readonly 'x-ontos-operation-context': Schema.optional<Schema.String>;
}>;
export declare const createMultiSelectOptionAndSelectActionResponseSchema: Schema.Struct<{
    readonly definitionRevision: Schema.Finite;
    readonly option: Schema.Struct<{
        readonly catalogPosition: Schema.Finite;
        readonly color: Schema.String;
        readonly name: Schema.String;
        readonly optionId: Schema.String;
        readonly revision: Schema.Finite;
        readonly updatedAt: Schema.String;
    }>;
    readonly taskRevision: Schema.Finite;
    readonly value: Schema.Struct<{
        readonly optionIds: Schema.$Array<Schema.String>;
        readonly propertyDefinitionId: Schema.String;
        readonly revision: Schema.Finite;
        readonly updatedAt: Schema.String;
    }>;
}>;
export declare const createMultiSelectOptionAndSelectActionOutcomeSchema: Schema.Struct<{
    readonly actionInvocationId: Schema.optional<Schema.String>;
    readonly ok: Schema.Literal<true>;
    readonly response: Schema.Struct<{
        readonly definitionRevision: Schema.Finite;
        readonly option: Schema.Struct<{
            readonly catalogPosition: Schema.Finite;
            readonly color: Schema.String;
            readonly name: Schema.String;
            readonly optionId: Schema.String;
            readonly revision: Schema.Finite;
            readonly updatedAt: Schema.String;
        }>;
        readonly taskRevision: Schema.Finite;
        readonly value: Schema.Struct<{
            readonly optionIds: Schema.$Array<Schema.String>;
            readonly propertyDefinitionId: Schema.String;
            readonly revision: Schema.Finite;
            readonly updatedAt: Schema.String;
        }>;
    }>;
}>;
export declare const createMultiSelectOptionAndSelectActionFailureSchemas: readonly [Schema.Struct<{
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
export declare const createMultiSelectOptionAndSelectActionFailureSchema: Schema.Union<readonly [Schema.Struct<{
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
export type CreateMultiSelectOptionAndSelectActionPayload = typeof createMultiSelectOptionAndSelectActionPayloadSchema.Type;
export type CreateMultiSelectOptionAndSelectActionResponse = typeof createMultiSelectOptionAndSelectActionResponseSchema.Type;
export type CreateMultiSelectOptionAndSelectActionOutcome = typeof createMultiSelectOptionAndSelectActionOutcomeSchema.Type;
export type CreateMultiSelectOptionAndSelectActionFailure = typeof createMultiSelectOptionAndSelectActionFailureSchema.Type;
export declare const createMultiSelectOptionAndSelectActionTitle: 'Create Multi-select Option And Select';
