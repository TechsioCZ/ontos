import type { Schema } from '@modern-js/plugin-bff/effect-client';

export declare const checkboxPropertyValueSchema: Schema.Struct<{
  readonly propertyDefinitionId: Schema.String;
  readonly revision: Schema.Finite;
  readonly value: Schema.Boolean;
}>;
export declare const selectPropertyValueSchema: Schema.Struct<{
  readonly optionId: Schema.optional<Schema.String>;
  readonly propertyDefinitionId: Schema.String;
  readonly revision: Schema.Finite;
}>;
export declare const numberPropertyValueSchema: Schema.Struct<{
  readonly propertyDefinitionId: Schema.String;
  readonly revision: Schema.Finite;
  readonly value: Schema.Union<readonly [Schema.String, Schema.Null]>;
}>;
export declare const urlPropertyValueSchema: Schema.Struct<{
  readonly propertyDefinitionId: Schema.String;
  readonly revision: Schema.Finite;
  readonly value: Schema.NullOr<Schema.String>;
}>;
export declare const emailPropertyValueSchema: Schema.Struct<{
  readonly propertyDefinitionId: Schema.String;
  readonly revision: Schema.Finite;
  readonly value: Schema.NullOr<Schema.String>;
}>;
export declare const phonePropertyValueSchema: Schema.Struct<{
  readonly propertyDefinitionId: Schema.String;
  readonly revision: Schema.Finite;
  readonly value: Schema.String;
}>;
export declare const resolvedPersonSchema: Schema.Struct<{
  readonly displayName: Schema.String;
  readonly eligible: Schema.Boolean;
  readonly principalId: Schema.String;
  readonly status: Schema.Literals<readonly ['active', 'archived', 'disabled', 'departed']>;
}>;
export declare const personPropertyValueSchema: Schema.Struct<{
  readonly people: Schema.$Array<
    Schema.Struct<{
      readonly displayName: Schema.String;
      readonly eligible: Schema.Boolean;
      readonly principalId: Schema.String;
      readonly status: Schema.Literals<readonly ['active', 'archived', 'disabled', 'departed']>;
    }>
  >;
  readonly principalIds: Schema.$Array<Schema.String>;
  readonly propertyDefinitionId: Schema.String;
  readonly revision: Schema.Finite;
}>;
export declare const taskPropertyWorkspaceSchema: Schema.Struct<{
  readonly collectionId: Schema.String;
  readonly effectiveTimeZone: Schema.optional<
    Schema.Struct<{
      readonly source: Schema.Literals<
        readonly ['browser_fallback', 'configured', 'system_fallback']
      >;
      readonly timeZone: Schema.String;
    }>
  >;
  readonly propertyDefinitions: Schema.$Array<
    Schema.Union<
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
    >
  >;
  readonly tasks: Schema.$Array<
    Schema.Struct<{
      readonly checkboxValues: Schema.$Array<
        Schema.Struct<{
          readonly propertyDefinitionId: Schema.String;
          readonly revision: Schema.Finite;
          readonly value: Schema.Boolean;
        }>
      >;
      readonly createdAt: Schema.optional<Schema.String>;
      readonly createdBy: Schema.optional<
        Schema.Struct<{
          readonly displayName: Schema.String;
          readonly inactive: Schema.Boolean;
          readonly principalId: Schema.String;
        }>
      >;
      readonly emailValues: Schema.$Array<
        Schema.Struct<{
          readonly propertyDefinitionId: Schema.String;
          readonly revision: Schema.Finite;
          readonly value: Schema.NullOr<Schema.String>;
        }>
      >;
      readonly numberValues: Schema.optional<
        Schema.$Array<
          Schema.Struct<{
            readonly propertyDefinitionId: Schema.String;
            readonly revision: Schema.Finite;
            readonly value: Schema.Union<readonly [Schema.String, Schema.Null]>;
          }>
        >
      >;
      readonly personValues: Schema.optional<
        Schema.$Array<
          Schema.Struct<{
            readonly people: Schema.$Array<
              Schema.Struct<{
                readonly displayName: Schema.String;
                readonly eligible: Schema.Boolean;
                readonly principalId: Schema.String;
                readonly status: Schema.Literals<
                  readonly ['active', 'archived', 'disabled', 'departed']
                >;
              }>
            >;
            readonly principalIds: Schema.$Array<Schema.String>;
            readonly propertyDefinitionId: Schema.String;
            readonly revision: Schema.Finite;
          }>
        >
      >;
      readonly phoneValues: Schema.$Array<
        Schema.Struct<{
          readonly propertyDefinitionId: Schema.String;
          readonly revision: Schema.Finite;
          readonly value: Schema.String;
        }>
      >;
      readonly selectValues: Schema.optional<
        Schema.$Array<
          Schema.Struct<{
            readonly optionId: Schema.optional<Schema.String>;
            readonly propertyDefinitionId: Schema.String;
            readonly revision: Schema.Finite;
          }>
        >
      >;
      readonly taskId: Schema.String;
      readonly taskRevision: Schema.Finite;
      readonly textValues: Schema.optional<
        Schema.$Array<
          Schema.Struct<{
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
                                    readonly [
                                      'bold',
                                      'italic',
                                      'underline',
                                      'strikethrough',
                                      'code',
                                    ]
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
          }>
        >
      >;
      readonly title: Schema.String;
      readonly urlValues: Schema.optional<
        Schema.$Array<
          Schema.Struct<{
            readonly propertyDefinitionId: Schema.String;
            readonly revision: Schema.Finite;
            readonly value: Schema.NullOr<Schema.String>;
          }>
        >
      >;
    }>
  >;
}>;
export declare const getTaskPropertyWorkspacePayloadSchema: Schema.Struct<{
  readonly browserTimeZone: Schema.optional<Schema.String>;
  readonly collectionId: Schema.String;
  readonly locale: Schema.optional<Schema.String>;
}>;
export type GetTaskPropertyWorkspacePayload = typeof getTaskPropertyWorkspacePayloadSchema.Type;
export type CheckboxPropertyValue = typeof checkboxPropertyValueSchema.Type;
export type PhonePropertyValue = typeof phonePropertyValueSchema.Type;
export type TaskPropertyWorkspace = typeof taskPropertyWorkspaceSchema.Type;
export type UrlPropertyValue = typeof urlPropertyValueSchema.Type;
