import type { Schema } from '@modern-js/plugin-bff/effect-client';

export declare const updateTextPropertyValueActionKey: 'ticketing.updateTextPropertyValue';
export declare const updateTextPropertyValueActionPayloadSchema: Schema.Struct<{
  readonly collectionId: Schema.String;
  readonly document: Schema.Union<
    readonly [
      Schema.Null,
      Schema.Struct<{
        readonly content: Schema.$Array<
          Schema.Union<
            readonly [
              Schema.Struct<{
                readonly marks: Schema.$Array<
                  Schema.Union<
                    readonly [
                      Schema.Struct<{
                        readonly type: Schema.Literals<
                          readonly ['bold', 'italic', 'underline', 'strikethrough', 'code']
                        >;
                      }>,
                      Schema.Struct<{
                        readonly color: Schema.String;
                        readonly type: Schema.Literal<'foregroundColor'>;
                      }>,
                      Schema.Struct<{
                        readonly color: Schema.String;
                        readonly type: Schema.Literal<'backgroundColor'>;
                      }>,
                      Schema.Struct<{
                        readonly href: Schema.String;
                        readonly type: Schema.Literal<'link'>;
                      }>,
                    ]
                  >
                >;
                readonly text: Schema.String;
                readonly type: Schema.Literal<'text'>;
              }>,
              Schema.Struct<{
                readonly type: Schema.Literal<'lineBreak'>;
              }>,
              Schema.Struct<{
                readonly expression: Schema.String;
                readonly type: Schema.Literal<'equation'>;
              }>,
              Schema.Struct<{
                readonly reference: Schema.Struct<{
                  readonly entityId: Schema.String;
                  readonly entityType: Schema.String;
                  readonly kind: Schema.Literals<readonly ['mention', 'relation']>;
                  readonly lastResolvedLabel: Schema.String;
                  readonly ownerModuleKey: Schema.String;
                  readonly targetTenantId: Schema.String;
                  readonly token: Schema.String;
                }>;
                readonly type: Schema.Literal<'reference'>;
              }>,
            ]
          >
        >;
        readonly type: Schema.Literal<'textDocument'>;
      }>,
    ]
  >;
  readonly expectedRevision: Schema.Finite;
  readonly propertyDefinitionId: Schema.String;
  readonly taskId: Schema.String;
}>;
export declare const updateTextPropertyValueActionHeadersSchema: Schema.Struct<{
  readonly 'Idempotency-Key': Schema.optional<Schema.String>;
  readonly 'x-ontos-operation-context': Schema.optional<Schema.String>;
}>;
export declare const updateTextPropertyValueActionResponseSchema: Schema.Struct<{
  readonly taskRevision: Schema.Finite;
  readonly value: Schema.Struct<{
    readonly document: Schema.Union<
      readonly [
        Schema.Null,
        Schema.Struct<{
          readonly content: Schema.$Array<
            Schema.Union<
              readonly [
                Schema.Struct<{
                  readonly marks: Schema.$Array<
                    Schema.Union<
                      readonly [
                        Schema.Struct<{
                          readonly type: Schema.Literals<
                            readonly ['bold', 'italic', 'underline', 'strikethrough', 'code']
                          >;
                        }>,
                        Schema.Struct<{
                          readonly color: Schema.String;
                          readonly type: Schema.Literal<'foregroundColor'>;
                        }>,
                        Schema.Struct<{
                          readonly color: Schema.String;
                          readonly type: Schema.Literal<'backgroundColor'>;
                        }>,
                        Schema.Struct<{
                          readonly href: Schema.String;
                          readonly type: Schema.Literal<'link'>;
                        }>,
                      ]
                    >
                  >;
                  readonly text: Schema.String;
                  readonly type: Schema.Literal<'text'>;
                }>,
                Schema.Struct<{
                  readonly type: Schema.Literal<'lineBreak'>;
                }>,
                Schema.Struct<{
                  readonly expression: Schema.String;
                  readonly type: Schema.Literal<'equation'>;
                }>,
                Schema.Struct<{
                  readonly reference: Schema.Struct<{
                    readonly entityId: Schema.String;
                    readonly entityType: Schema.String;
                    readonly kind: Schema.Literals<readonly ['mention', 'relation']>;
                    readonly lastResolvedLabel: Schema.String;
                    readonly ownerModuleKey: Schema.String;
                    readonly targetTenantId: Schema.String;
                    readonly token: Schema.String;
                  }>;
                  readonly type: Schema.Literal<'reference'>;
                }>,
              ]
            >
          >;
          readonly type: Schema.Literal<'textDocument'>;
        }>,
      ]
    >;
    readonly propertyDefinitionId: Schema.String;
    readonly readableText: Schema.Union<readonly [Schema.Null, Schema.String]>;
    readonly revision: Schema.Finite;
  }>;
}>;
export declare const updateTextPropertyValueActionOutcomeSchema: Schema.Struct<{
  readonly actionInvocationId: Schema.optional<Schema.String>;
  readonly ok: Schema.Literal<true>;
  readonly response: Schema.Struct<{
    readonly taskRevision: Schema.Finite;
    readonly value: Schema.Struct<{
      readonly document: Schema.Union<
        readonly [
          Schema.Null,
          Schema.Struct<{
            readonly content: Schema.$Array<
              Schema.Union<
                readonly [
                  Schema.Struct<{
                    readonly marks: Schema.$Array<
                      Schema.Union<
                        readonly [
                          Schema.Struct<{
                            readonly type: Schema.Literals<
                              readonly ['bold', 'italic', 'underline', 'strikethrough', 'code']
                            >;
                          }>,
                          Schema.Struct<{
                            readonly color: Schema.String;
                            readonly type: Schema.Literal<'foregroundColor'>;
                          }>,
                          Schema.Struct<{
                            readonly color: Schema.String;
                            readonly type: Schema.Literal<'backgroundColor'>;
                          }>,
                          Schema.Struct<{
                            readonly href: Schema.String;
                            readonly type: Schema.Literal<'link'>;
                          }>,
                        ]
                      >
                    >;
                    readonly text: Schema.String;
                    readonly type: Schema.Literal<'text'>;
                  }>,
                  Schema.Struct<{
                    readonly type: Schema.Literal<'lineBreak'>;
                  }>,
                  Schema.Struct<{
                    readonly expression: Schema.String;
                    readonly type: Schema.Literal<'equation'>;
                  }>,
                  Schema.Struct<{
                    readonly reference: Schema.Struct<{
                      readonly entityId: Schema.String;
                      readonly entityType: Schema.String;
                      readonly kind: Schema.Literals<readonly ['mention', 'relation']>;
                      readonly lastResolvedLabel: Schema.String;
                      readonly ownerModuleKey: Schema.String;
                      readonly targetTenantId: Schema.String;
                      readonly token: Schema.String;
                    }>;
                    readonly type: Schema.Literal<'reference'>;
                  }>,
                ]
              >
            >;
            readonly type: Schema.Literal<'textDocument'>;
          }>,
        ]
      >;
      readonly propertyDefinitionId: Schema.String;
      readonly readableText: Schema.Union<readonly [Schema.Null, Schema.String]>;
      readonly revision: Schema.Finite;
    }>;
  }>;
}>;
export declare const updateTextPropertyValueActionFailureSchemas: readonly [
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
export declare const updateTextPropertyValueActionFailureSchema: Schema.Union<
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
export type UpdateTextPropertyValueActionPayload =
  typeof updateTextPropertyValueActionPayloadSchema.Type;
export type UpdateTextPropertyValueActionResponse =
  typeof updateTextPropertyValueActionResponseSchema.Type;
export type UpdateTextPropertyValueActionOutcome =
  typeof updateTextPropertyValueActionOutcomeSchema.Type;
export type UpdateTextPropertyValueActionFailure =
  typeof updateTextPropertyValueActionFailureSchema.Type;
export declare const updateTextPropertyValueActionTitle: 'Update Text Property Value';
