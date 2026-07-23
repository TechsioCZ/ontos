import { Schema } from '@modern-js/plugin-bff/effect-client';
export declare const uploadFilesMediaItemsActionKey: 'ticketing.uploadFilesMediaItems';
export declare const filesMediaUploadSchema: Schema.Struct<{
    readonly bytesBase64: Schema.String;
    readonly clientMimeType: Schema.optional<Schema.String>;
    readonly filename: Schema.String;
}>;
export declare const uploadFilesMediaItemsActionPayloadSchema: Schema.Struct<{
    readonly collectionId: Schema.String;
    readonly expectedRevision: Schema.Finite;
    readonly files: Schema.$Array<Schema.Struct<{
        readonly bytesBase64: Schema.String;
        readonly clientMimeType: Schema.optional<Schema.String>;
        readonly filename: Schema.String;
    }>>;
    readonly propertyDefinitionId: Schema.String;
    readonly taskId: Schema.String;
}>;
export declare const uploadFilesMediaItemsActionHeadersSchema: Schema.Struct<{
    readonly 'Idempotency-Key': Schema.optional<Schema.String>;
    readonly 'x-ontos-operation-context': Schema.optional<Schema.String>;
}>;
export declare const filesMediaUploadOutcomeSchema: Schema.Union<readonly [Schema.Struct<{
    readonly item: Schema.Union<readonly [Schema.Struct<{
        readonly access: Schema.Literal<"download">;
        readonly byteSize: Schema.Finite;
        readonly displayFilename: Schema.String;
        readonly effectiveMimeType: Schema.String;
        readonly itemId: Schema.String;
        readonly mediaAssetId: Schema.String;
        readonly position: Schema.Finite;
        readonly propertyDefinitionId: Schema.String;
    }>, Schema.Struct<{
        readonly access: Schema.Literal<"external">;
        readonly externalUrl: Schema.String;
        readonly itemId: Schema.String;
        readonly position: Schema.Finite;
        readonly propertyDefinitionId: Schema.String;
    }>]>;
    readonly ok: Schema.Literal<true>;
}>, Schema.Struct<{
    readonly code: Schema.String;
    readonly message: Schema.String;
    readonly ok: Schema.Literal<false>;
}>]>;
export declare const uploadFilesMediaItemsActionResponseSchema: Schema.Struct<{
    readonly outcomes: Schema.$Array<Schema.Union<readonly [Schema.Struct<{
        readonly item: Schema.Union<readonly [Schema.Struct<{
            readonly access: Schema.Literal<"download">;
            readonly byteSize: Schema.Finite;
            readonly displayFilename: Schema.String;
            readonly effectiveMimeType: Schema.String;
            readonly itemId: Schema.String;
            readonly mediaAssetId: Schema.String;
            readonly position: Schema.Finite;
            readonly propertyDefinitionId: Schema.String;
        }>, Schema.Struct<{
            readonly access: Schema.Literal<"external">;
            readonly externalUrl: Schema.String;
            readonly itemId: Schema.String;
            readonly position: Schema.Finite;
            readonly propertyDefinitionId: Schema.String;
        }>]>;
        readonly ok: Schema.Literal<true>;
    }>, Schema.Struct<{
        readonly code: Schema.String;
        readonly message: Schema.String;
        readonly ok: Schema.Literal<false>;
    }>]>>;
    readonly taskRevision: Schema.Finite;
}>;
export declare const uploadFilesMediaItemsActionOutcomeSchema: Schema.Struct<{
    readonly actionInvocationId: Schema.optional<Schema.String>;
    readonly ok: Schema.Literal<true>;
    readonly response: Schema.Struct<{
        readonly outcomes: Schema.$Array<Schema.Union<readonly [Schema.Struct<{
            readonly item: Schema.Union<readonly [Schema.Struct<{
                readonly access: Schema.Literal<"download">;
                readonly byteSize: Schema.Finite;
                readonly displayFilename: Schema.String;
                readonly effectiveMimeType: Schema.String;
                readonly itemId: Schema.String;
                readonly mediaAssetId: Schema.String;
                readonly position: Schema.Finite;
                readonly propertyDefinitionId: Schema.String;
            }>, Schema.Struct<{
                readonly access: Schema.Literal<"external">;
                readonly externalUrl: Schema.String;
                readonly itemId: Schema.String;
                readonly position: Schema.Finite;
                readonly propertyDefinitionId: Schema.String;
            }>]>;
            readonly ok: Schema.Literal<true>;
        }>, Schema.Struct<{
            readonly code: Schema.String;
            readonly message: Schema.String;
            readonly ok: Schema.Literal<false>;
        }>]>>;
        readonly taskRevision: Schema.Finite;
    }>;
}>;
export declare const uploadFilesMediaItemsActionFailureSchemas: readonly [Schema.Struct<{
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
export declare const uploadFilesMediaItemsActionFailureSchema: Schema.Union<readonly [Schema.Struct<{
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
export type FilesMediaUpload = typeof filesMediaUploadSchema.Type;
export type FilesMediaUploadOutcome = typeof filesMediaUploadOutcomeSchema.Type;
export type UploadFilesMediaItemsActionPayload = typeof uploadFilesMediaItemsActionPayloadSchema.Type;
export type UploadFilesMediaItemsActionResponse = typeof uploadFilesMediaItemsActionResponseSchema.Type;
export type UploadFilesMediaItemsActionOutcome = typeof uploadFilesMediaItemsActionOutcomeSchema.Type;
export type UploadFilesMediaItemsActionFailure = typeof uploadFilesMediaItemsActionFailureSchema.Type;
