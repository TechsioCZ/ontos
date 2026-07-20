import type { Schema } from '@modern-js/plugin-bff/effect-client';

export declare const taskRetentionStateSchema: Schema.Literals<
  readonly ['active', 'archived', 'softDeleted']
>;
export declare const transitionTaskRetentionActionKey: 'ticketing.transitionTaskRetention';
export declare const transitionTaskRetentionActionPayloadSchema: Schema.Struct<{
  readonly collectionId: Schema.String;
  readonly expectedRevision: Schema.Finite;
  readonly taskId: Schema.String;
  readonly transition: Schema.Literals<readonly ['archive', 'restore', 'softDelete', 'hardDelete']>;
}>;
export declare const transitionTaskRetentionActionHeadersSchema: Schema.Struct<{
  readonly 'Idempotency-Key': Schema.optional<Schema.String>;
  readonly 'x-ontos-operation-context': Schema.optional<Schema.String>;
}>;
export declare const retainedTaskTransitionResponseSchema: Schema.Struct<{
  readonly retentionState: Schema.Literals<readonly ['active', 'archived', 'softDeleted']>;
  readonly taskId: Schema.String;
  readonly taskRevision: Schema.Finite;
}>;
export declare const hardDeletedTaskTransitionResponseSchema: Schema.Struct<{
  readonly hardDeletedTaskId: Schema.String;
  readonly retentionState: Schema.Literal<'hardDeleted'>;
}>;
export declare const transitionTaskRetentionActionResponseSchema: Schema.Union<
  readonly [
    Schema.Struct<{
      readonly retentionState: Schema.Literals<readonly ['active', 'archived', 'softDeleted']>;
      readonly taskId: Schema.String;
      readonly taskRevision: Schema.Finite;
    }>,
    Schema.Struct<{
      readonly hardDeletedTaskId: Schema.String;
      readonly retentionState: Schema.Literal<'hardDeleted'>;
    }>,
  ]
>;
export declare const transitionTaskRetentionActionOutcomeSchema: Schema.Struct<{
  readonly actionInvocationId: Schema.optional<Schema.String>;
  readonly ok: Schema.Literal<true>;
  readonly response: Schema.Union<
    readonly [
      Schema.Struct<{
        readonly retentionState: Schema.Literals<readonly ['active', 'archived', 'softDeleted']>;
        readonly taskId: Schema.String;
        readonly taskRevision: Schema.Finite;
      }>,
      Schema.Struct<{
        readonly hardDeletedTaskId: Schema.String;
        readonly retentionState: Schema.Literal<'hardDeleted'>;
      }>,
    ]
  >;
}>;
export declare const transitionTaskRetentionActionFailureSchemas: readonly [
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
export declare const transitionTaskRetentionActionFailureSchema: Schema.Union<
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
export type TaskRetentionState = typeof taskRetentionStateSchema.Type;
export type TransitionTaskRetentionActionPayload =
  typeof transitionTaskRetentionActionPayloadSchema.Type;
export type TransitionTaskRetentionActionResponse =
  typeof transitionTaskRetentionActionResponseSchema.Type;
export type TransitionTaskRetentionActionOutcome =
  typeof transitionTaskRetentionActionOutcomeSchema.Type;
export type TransitionTaskRetentionActionFailure =
  typeof transitionTaskRetentionActionFailureSchema.Type;
export declare const transitionTaskRetentionActionTitle: 'Transition Task Retention';
