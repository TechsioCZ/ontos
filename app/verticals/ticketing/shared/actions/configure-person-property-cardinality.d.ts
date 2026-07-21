import type { Schema } from '@modern-js/plugin-bff/effect-client';

export declare const configurePersonPropertyCardinalityActionKey: 'ticketing.configurePersonPropertyCardinality';
export declare const configurePersonPropertyCardinalityActionPayloadSchema: Schema.Struct<{
  readonly cardinality: Schema.Literals<readonly ['one', 'unlimited']>;
  readonly collectionId: Schema.String;
  readonly expectedRevision: Schema.Finite;
  readonly propertyDefinitionId: Schema.String;
}>;
export declare const configurePersonPropertyCardinalityActionHeadersSchema: Schema.Struct<{
  readonly 'Idempotency-Key': Schema.optional<Schema.String>;
  readonly 'x-ontos-operation-context': Schema.optional<Schema.String>;
}>;
export declare const configurePersonPropertyCardinalityActionResponseSchema: Schema.Struct<{
  readonly definition: Schema.Struct<{
    readonly cardinality: Schema.Literals<readonly ['one', 'unlimited']>;
    readonly datatype: Schema.Literal<'person'>;
    readonly hidden: Schema.Boolean;
    readonly mandatory: Schema.Boolean;
    readonly name: Schema.String;
    readonly propertyDefinitionId: Schema.String;
    readonly revision: Schema.Finite;
  }>;
}>;
export declare const configurePersonPropertyCardinalityActionOutcomeSchema: Schema.Struct<{
  readonly actionInvocationId: Schema.optional<Schema.String>;
  readonly ok: Schema.Literal<true>;
  readonly response: Schema.Struct<{
    readonly definition: Schema.Struct<{
      readonly cardinality: Schema.Literals<readonly ['one', 'unlimited']>;
      readonly datatype: Schema.Literal<'person'>;
      readonly hidden: Schema.Boolean;
      readonly mandatory: Schema.Boolean;
      readonly name: Schema.String;
      readonly propertyDefinitionId: Schema.String;
      readonly revision: Schema.Finite;
    }>;
  }>;
}>;
export declare const configurePersonPropertyCardinalityConflictFailureSchema: Schema.Struct<{
  readonly errorTag: Schema.Literal<'OperationDomainRejected'>;
  readonly httpStatus: Schema.Finite;
  readonly message: Schema.String;
  readonly ok: Schema.Literal<false>;
  readonly code: Schema.Literal<'ticketing.configurePersonPropertyCardinality.assignments_violate_limit'>;
  readonly state: Schema.Struct<{
    readonly violatingTaskCount: Schema.Finite;
  }>;
}>;
export declare const configurePersonPropertyCardinalityActionFailureSchemas: readonly [
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
    readonly errorTag: Schema.Literal<'OperationDomainRejected'>;
    readonly httpStatus: Schema.Finite;
    readonly message: Schema.String;
    readonly ok: Schema.Literal<false>;
    readonly code: Schema.Literal<'ticketing.configurePersonPropertyCardinality.assignments_violate_limit'>;
    readonly state: Schema.Struct<{
      readonly violatingTaskCount: Schema.Finite;
    }>;
  }>,
  Schema.Struct<{
    readonly errorTag: Schema.Literal<'OperationDomainRejected'>;
    readonly httpStatus: Schema.Finite;
    readonly message: Schema.String;
    readonly ok: Schema.Literal<false>;
    readonly code: Schema.Literal<'ticketing.configurePersonPropertyCardinality.stale_or_missing'>;
  }>,
  Schema.Struct<{
    readonly code: Schema.optional<Schema.String>;
    readonly errorTag: Schema.Literals<
      readonly [
        'OperationIdempotencyConflict',
        'OperationIdempotencyReplayUnavailable',
        'OperationPolicyDenied',
      ]
    >;
    readonly httpStatus: Schema.Finite;
    readonly message: Schema.String;
    readonly ok: Schema.Literal<false>;
    readonly state: Schema.optional<Schema.Codec<Schema.Json, Schema.Json, never, never>>;
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
export declare const configurePersonPropertyCardinalityActionFailureSchema: Schema.Union<
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
      readonly errorTag: Schema.Literal<'OperationDomainRejected'>;
      readonly httpStatus: Schema.Finite;
      readonly message: Schema.String;
      readonly ok: Schema.Literal<false>;
      readonly code: Schema.Literal<'ticketing.configurePersonPropertyCardinality.assignments_violate_limit'>;
      readonly state: Schema.Struct<{
        readonly violatingTaskCount: Schema.Finite;
      }>;
    }>,
    Schema.Struct<{
      readonly errorTag: Schema.Literal<'OperationDomainRejected'>;
      readonly httpStatus: Schema.Finite;
      readonly message: Schema.String;
      readonly ok: Schema.Literal<false>;
      readonly code: Schema.Literal<'ticketing.configurePersonPropertyCardinality.stale_or_missing'>;
    }>,
    Schema.Struct<{
      readonly code: Schema.optional<Schema.String>;
      readonly errorTag: Schema.Literals<
        readonly [
          'OperationIdempotencyConflict',
          'OperationIdempotencyReplayUnavailable',
          'OperationPolicyDenied',
        ]
      >;
      readonly httpStatus: Schema.Finite;
      readonly message: Schema.String;
      readonly ok: Schema.Literal<false>;
      readonly state: Schema.optional<Schema.Codec<Schema.Json, Schema.Json, never, never>>;
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
export type ConfigurePersonPropertyCardinalityActionPayload =
  typeof configurePersonPropertyCardinalityActionPayloadSchema.Type;
export type ConfigurePersonPropertyCardinalityActionResponse =
  typeof configurePersonPropertyCardinalityActionResponseSchema.Type;
export type ConfigurePersonPropertyCardinalityActionOutcome =
  typeof configurePersonPropertyCardinalityActionOutcomeSchema.Type;
export type ConfigurePersonPropertyCardinalityActionFailure =
  typeof configurePersonPropertyCardinalityActionFailureSchema.Type;
export declare const configurePersonPropertyCardinalityActionTitle: 'Configure Person Property Cardinality';
