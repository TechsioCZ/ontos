import type { Schema } from '@modern-js/plugin-bff/effect-client';

export declare const textMarkSchema: Schema.Union<
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
>;
export declare const coreReferenceSchema: Schema.Struct<{
  readonly entityId: Schema.String;
  readonly entityType: Schema.String;
  readonly kind: Schema.Literals<readonly ['mention', 'relation']>;
  readonly lastResolvedLabel: Schema.String;
  readonly ownerModuleKey: Schema.String;
  readonly targetTenantId: Schema.String;
  readonly token: Schema.String;
}>;
export declare const textInlineNodeSchema: Schema.Union<
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
>;
export declare const textDocumentSchema: Schema.Struct<{
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
}>;
export declare const nullableTextDocumentSchema: Schema.Union<
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
export declare const textPropertyValueSchema: Schema.Struct<{
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
export type TextMark = typeof textMarkSchema.Type;
export type CoreReference = typeof coreReferenceSchema.Type;
export type TextInlineNode = typeof textInlineNodeSchema.Type;
export type TextDocument = typeof textDocumentSchema.Type;
export type TextPropertyValue = typeof textPropertyValueSchema.Type;
