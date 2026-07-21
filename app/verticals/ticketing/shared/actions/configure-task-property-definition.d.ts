import type { Schema } from '@modern-js/plugin-bff/effect-client';

export declare const configureTaskPropertyDefinitionActionKey: 'ticketing.configureTaskPropertyDefinition';
export declare const configureTaskPropertyDefinitionActionPayloadSchema: Schema.Struct<{
  readonly collectionId: Schema.String;
  readonly expectedRevision: Schema.Finite;
  readonly hidden: Schema.Boolean;
  readonly mandatory: Schema.Boolean;
  readonly name: Schema.String;
  readonly propertyDefinitionId: Schema.String;
}>;
export declare const configureTaskPropertyDefinitionActionHeadersSchema: Schema.Struct<{
  readonly 'Idempotency-Key': Schema.optional<Schema.String>;
  readonly 'x-ontos-operation-context': Schema.optional<Schema.String>;
}>;
export declare const configureTaskPropertyDefinitionActionResponseSchema: Schema.Struct<{
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
export declare const configureTaskPropertyDefinitionActionOutcomeSchema: Schema.Struct<{
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
export declare const configureTaskPropertyDefinitionActionFailureSchemas: readonly [
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
export declare const configureTaskPropertyDefinitionActionFailureSchema: Schema.Union<
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
export type ConfigureTaskPropertyDefinitionActionPayload =
  typeof configureTaskPropertyDefinitionActionPayloadSchema.Type;
export type ConfigureTaskPropertyDefinitionActionResponse =
  typeof configureTaskPropertyDefinitionActionResponseSchema.Type;
export type ConfigureTaskPropertyDefinitionActionOutcome =
  typeof configureTaskPropertyDefinitionActionOutcomeSchema.Type;
export type ConfigureTaskPropertyDefinitionActionFailure =
  typeof configureTaskPropertyDefinitionActionFailureSchema.Type;
export declare const configureTaskPropertyDefinitionActionTitle: 'Configure Task Property Definition';
