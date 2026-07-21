import type { Schema } from '@modern-js/plugin-bff/effect-client';

export declare const duplicateTaskPropertyDefinitionActionKey: 'ticketing.duplicateTaskPropertyDefinition';
export declare const duplicateTaskPropertyDefinitionActionPayloadSchema: Schema.Struct<{
  readonly collectionId: Schema.String;
  readonly copyValues: Schema.optional<Schema.Boolean>;
  readonly expectedRevision: Schema.Finite;
  readonly propertyDefinitionId: Schema.String;
}>;
export declare const duplicateTaskPropertyDefinitionActionHeadersSchema: Schema.Struct<{
  readonly 'Idempotency-Key': Schema.optional<Schema.String>;
  readonly 'x-ontos-operation-context': Schema.optional<Schema.String>;
}>;
export declare const duplicateTaskPropertyDefinitionActionResponseSchema: Schema.Struct<{
  readonly definition: Schema.Union<
    readonly [
      Schema.Struct<{
        readonly datatype: Schema.Literal<'checkbox'>;
        readonly hidden: Schema.Boolean;
        readonly mandatory: Schema.Boolean;
        readonly name: Schema.String;
        readonly propertyDefinitionId: Schema.String;
        readonly revision: Schema.Finite;
      }>,
      Schema.Struct<{
        readonly datatype: Schema.Literal<'date'>;
        readonly hidden: Schema.Boolean;
        readonly mandatory: Schema.Boolean;
        readonly name: Schema.String;
        readonly propertyDefinitionId: Schema.String;
        readonly revision: Schema.Finite;
      }>,
      Schema.Struct<{
        readonly datatype: Schema.Literal<'email'>;
        readonly hidden: Schema.Boolean;
        readonly mandatory: Schema.Boolean;
        readonly name: Schema.String;
        readonly propertyDefinitionId: Schema.String;
        readonly revision: Schema.Finite;
      }>,
      Schema.Struct<{
        readonly datatype: Schema.Literal<'files_media'>;
        readonly hidden: Schema.Boolean;
        readonly mandatory: Schema.Boolean;
        readonly name: Schema.String;
        readonly propertyDefinitionId: Schema.String;
        readonly revision: Schema.Finite;
      }>,
      Schema.Struct<{
        readonly datatype: Schema.Literal<'id'>;
        readonly hidden: Schema.Boolean;
        readonly mandatory: Schema.Boolean;
        readonly name: Schema.String;
        readonly prefix: Schema.String;
        readonly propertyDefinitionId: Schema.String;
        readonly revision: Schema.Finite;
      }>,
      Schema.Struct<{
        readonly datatype: Schema.Literals<readonly ['created_time', 'created_by']>;
        readonly hidden: Schema.Boolean;
        readonly mandatory: Schema.Boolean;
        readonly name: Schema.String;
        readonly propertyDefinitionId: Schema.String;
        readonly revision: Schema.Finite;
      }>,
      Schema.Struct<{
        readonly datatype: Schema.Literal<'number'>;
        readonly format: Schema.Literals<readonly ['number', 'number_with_separators', 'percent']>;
        readonly hidden: Schema.Boolean;
        readonly mandatory: Schema.Boolean;
        readonly name: Schema.String;
        readonly propertyDefinitionId: Schema.String;
        readonly revision: Schema.Finite;
      }>,
      Schema.Struct<{
        readonly cardinality: Schema.Literals<readonly ['one', 'unlimited']>;
        readonly datatype: Schema.Literal<'person'>;
        readonly hidden: Schema.Boolean;
        readonly mandatory: Schema.Boolean;
        readonly name: Schema.String;
        readonly propertyDefinitionId: Schema.String;
        readonly revision: Schema.Finite;
      }>,
      Schema.Struct<{
        readonly datatype: Schema.Literal<'phone'>;
        readonly hidden: Schema.Boolean;
        readonly mandatory: Schema.Boolean;
        readonly name: Schema.String;
        readonly propertyDefinitionId: Schema.String;
        readonly revision: Schema.Finite;
      }>,
      Schema.Struct<{
        readonly datatype: Schema.Literal<'select'>;
        readonly hidden: Schema.Boolean;
        readonly mandatory: Schema.Boolean;
        readonly name: Schema.String;
        readonly optionOrderMode: Schema.Literals<
          readonly ['manual', 'alphabetical', 'reverse_alphabetical']
        >;
        readonly options: Schema.$Array<
          Schema.Struct<{
            readonly color: Schema.String;
            readonly manualPosition: Schema.Finite;
            readonly name: Schema.String;
            readonly optionId: Schema.String;
            readonly revision: Schema.Finite;
          }>
        >;
        readonly propertyDefinitionId: Schema.String;
        readonly revision: Schema.Finite;
      }>,
      Schema.Struct<{
        readonly datatype: Schema.Literal<'text'>;
        readonly hidden: Schema.Boolean;
        readonly mandatory: Schema.Boolean;
        readonly name: Schema.String;
        readonly propertyDefinitionId: Schema.String;
        readonly revision: Schema.Finite;
      }>,
      Schema.Struct<{
        readonly datatype: Schema.Literal<'url'>;
        readonly hidden: Schema.Boolean;
        readonly mandatory: Schema.Boolean;
        readonly name: Schema.String;
        readonly propertyDefinitionId: Schema.String;
        readonly revision: Schema.Finite;
      }>,
    ]
  >;
}>;
export declare const duplicateTaskPropertyDefinitionActionOutcomeSchema: Schema.Struct<{
  readonly actionInvocationId: Schema.optional<Schema.String>;
  readonly ok: Schema.Literal<true>;
  readonly response: Schema.Struct<{
    readonly definition: Schema.Union<
      readonly [
        Schema.Struct<{
          readonly datatype: Schema.Literal<'checkbox'>;
          readonly hidden: Schema.Boolean;
          readonly mandatory: Schema.Boolean;
          readonly name: Schema.String;
          readonly propertyDefinitionId: Schema.String;
          readonly revision: Schema.Finite;
        }>,
        Schema.Struct<{
          readonly datatype: Schema.Literal<'date'>;
          readonly hidden: Schema.Boolean;
          readonly mandatory: Schema.Boolean;
          readonly name: Schema.String;
          readonly propertyDefinitionId: Schema.String;
          readonly revision: Schema.Finite;
        }>,
        Schema.Struct<{
          readonly datatype: Schema.Literal<'email'>;
          readonly hidden: Schema.Boolean;
          readonly mandatory: Schema.Boolean;
          readonly name: Schema.String;
          readonly propertyDefinitionId: Schema.String;
          readonly revision: Schema.Finite;
        }>,
        Schema.Struct<{
          readonly datatype: Schema.Literal<'files_media'>;
          readonly hidden: Schema.Boolean;
          readonly mandatory: Schema.Boolean;
          readonly name: Schema.String;
          readonly propertyDefinitionId: Schema.String;
          readonly revision: Schema.Finite;
        }>,
        Schema.Struct<{
          readonly datatype: Schema.Literal<'id'>;
          readonly hidden: Schema.Boolean;
          readonly mandatory: Schema.Boolean;
          readonly name: Schema.String;
          readonly prefix: Schema.String;
          readonly propertyDefinitionId: Schema.String;
          readonly revision: Schema.Finite;
        }>,
        Schema.Struct<{
          readonly datatype: Schema.Literals<readonly ['created_time', 'created_by']>;
          readonly hidden: Schema.Boolean;
          readonly mandatory: Schema.Boolean;
          readonly name: Schema.String;
          readonly propertyDefinitionId: Schema.String;
          readonly revision: Schema.Finite;
        }>,
        Schema.Struct<{
          readonly datatype: Schema.Literal<'number'>;
          readonly format: Schema.Literals<
            readonly ['number', 'number_with_separators', 'percent']
          >;
          readonly hidden: Schema.Boolean;
          readonly mandatory: Schema.Boolean;
          readonly name: Schema.String;
          readonly propertyDefinitionId: Schema.String;
          readonly revision: Schema.Finite;
        }>,
        Schema.Struct<{
          readonly cardinality: Schema.Literals<readonly ['one', 'unlimited']>;
          readonly datatype: Schema.Literal<'person'>;
          readonly hidden: Schema.Boolean;
          readonly mandatory: Schema.Boolean;
          readonly name: Schema.String;
          readonly propertyDefinitionId: Schema.String;
          readonly revision: Schema.Finite;
        }>,
        Schema.Struct<{
          readonly datatype: Schema.Literal<'phone'>;
          readonly hidden: Schema.Boolean;
          readonly mandatory: Schema.Boolean;
          readonly name: Schema.String;
          readonly propertyDefinitionId: Schema.String;
          readonly revision: Schema.Finite;
        }>,
        Schema.Struct<{
          readonly datatype: Schema.Literal<'select'>;
          readonly hidden: Schema.Boolean;
          readonly mandatory: Schema.Boolean;
          readonly name: Schema.String;
          readonly optionOrderMode: Schema.Literals<
            readonly ['manual', 'alphabetical', 'reverse_alphabetical']
          >;
          readonly options: Schema.$Array<
            Schema.Struct<{
              readonly color: Schema.String;
              readonly manualPosition: Schema.Finite;
              readonly name: Schema.String;
              readonly optionId: Schema.String;
              readonly revision: Schema.Finite;
            }>
          >;
          readonly propertyDefinitionId: Schema.String;
          readonly revision: Schema.Finite;
        }>,
        Schema.Struct<{
          readonly datatype: Schema.Literal<'text'>;
          readonly hidden: Schema.Boolean;
          readonly mandatory: Schema.Boolean;
          readonly name: Schema.String;
          readonly propertyDefinitionId: Schema.String;
          readonly revision: Schema.Finite;
        }>,
        Schema.Struct<{
          readonly datatype: Schema.Literal<'url'>;
          readonly hidden: Schema.Boolean;
          readonly mandatory: Schema.Boolean;
          readonly name: Schema.String;
          readonly propertyDefinitionId: Schema.String;
          readonly revision: Schema.Finite;
        }>,
      ]
    >;
  }>;
}>;
export declare const duplicateTaskPropertyDefinitionActionFailureSchemas: readonly [
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
export declare const duplicateTaskPropertyDefinitionActionFailureSchema: Schema.Union<
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
export type DuplicateTaskPropertyDefinitionActionPayload =
  typeof duplicateTaskPropertyDefinitionActionPayloadSchema.Type;
export type DuplicateTaskPropertyDefinitionActionResponse =
  typeof duplicateTaskPropertyDefinitionActionResponseSchema.Type;
export type DuplicateTaskPropertyDefinitionActionOutcome =
  typeof duplicateTaskPropertyDefinitionActionOutcomeSchema.Type;
export type DuplicateTaskPropertyDefinitionActionFailure =
  typeof duplicateTaskPropertyDefinitionActionFailureSchema.Type;
export declare const duplicateTaskPropertyDefinitionActionTitle: 'Duplicate Task Property Definition';
