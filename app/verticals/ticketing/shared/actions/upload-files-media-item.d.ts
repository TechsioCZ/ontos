import type { Schema } from '@modern-js/plugin-bff/effect-client';

export declare const uploadFilesMediaItemActionKey: 'ticketing.uploadFilesMediaItem';
export declare const uploadFilesMediaItemActionPayloadSchema: Schema.Struct<{
  readonly bytesBase64: Schema.String;
  readonly clientMimeType: Schema.optional<Schema.String>;
  readonly collectionId: Schema.String;
  readonly filename: Schema.String;
  readonly propertyDefinitionId: Schema.String;
  readonly taskId: Schema.String;
}>;
export declare const uploadFilesMediaItemActionHeadersSchema: Schema.Struct<{
  readonly 'Idempotency-Key': Schema.optional<Schema.String>;
  readonly 'x-ontos-operation-context': Schema.optional<Schema.String>;
}>;
export declare const filesMediaItemSchema: Schema.Struct<{
  readonly access: Schema.Literal<'download'>;
  readonly byteSize: Schema.Finite;
  readonly displayFilename: Schema.String;
  readonly effectiveMimeType: Schema.String;
  readonly itemId: Schema.String;
  readonly mediaAssetId: Schema.String;
  readonly position: Schema.Finite;
  readonly propertyDefinitionId: Schema.String;
}>;
export declare const uploadFilesMediaItemActionResponseSchema: Schema.Struct<{
  readonly item: Schema.Struct<{
    readonly access: Schema.Literal<'download'>;
    readonly byteSize: Schema.Finite;
    readonly displayFilename: Schema.String;
    readonly effectiveMimeType: Schema.String;
    readonly itemId: Schema.String;
    readonly mediaAssetId: Schema.String;
    readonly position: Schema.Finite;
    readonly propertyDefinitionId: Schema.String;
  }>;
  readonly taskRevision: Schema.Finite;
}>;
export declare const uploadFilesMediaItemActionOutcomeSchema: Schema.Struct<{
  readonly actionInvocationId: Schema.optional<Schema.String>;
  readonly ok: Schema.Literal<true>;
  readonly response: Schema.Struct<{
    readonly item: Schema.Struct<{
      readonly access: Schema.Literal<'download'>;
      readonly byteSize: Schema.Finite;
      readonly displayFilename: Schema.String;
      readonly effectiveMimeType: Schema.String;
      readonly itemId: Schema.String;
      readonly mediaAssetId: Schema.String;
      readonly position: Schema.Finite;
      readonly propertyDefinitionId: Schema.String;
    }>;
    readonly taskRevision: Schema.Finite;
  }>;
}>;
export declare const uploadFilesMediaItemActionFailureSchemas: readonly [
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
export declare const uploadFilesMediaItemActionFailureSchema: Schema.Union<
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
export type FilesMediaItem = typeof filesMediaItemSchema.Type;
export type UploadFilesMediaItemActionPayload = typeof uploadFilesMediaItemActionPayloadSchema.Type;
export type UploadFilesMediaItemActionResponse =
  typeof uploadFilesMediaItemActionResponseSchema.Type;
export type UploadFilesMediaItemActionOutcome = typeof uploadFilesMediaItemActionOutcomeSchema.Type;
export type UploadFilesMediaItemActionFailure = typeof uploadFilesMediaItemActionFailureSchema.Type;
