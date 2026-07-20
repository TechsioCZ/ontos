import type { Schema } from '@modern-js/plugin-bff/effect-client';

export declare const checkboxPropertyValueSchema: Schema.Struct<{
  readonly propertyDefinitionId: Schema.String;
  readonly revision: Schema.Finite;
  readonly value: Schema.Boolean;
}>;
export declare const taskPropertyWorkspaceSchema: Schema.Struct<{
  readonly collectionId: Schema.String;
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
          readonly datatype: Schema.Literal<'text'>;
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
    }>
  >;
}>;
export declare const getTaskPropertyWorkspacePayloadSchema: Schema.Struct<{
  readonly collectionId: Schema.String;
}>;
export type GetTaskPropertyWorkspacePayload = typeof getTaskPropertyWorkspacePayloadSchema.Type;
export type TaskPropertyWorkspace = typeof taskPropertyWorkspaceSchema.Type;
