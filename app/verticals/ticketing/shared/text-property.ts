import { Schema } from '@modern-js/plugin-bff/effect-client';

export const textMarkSchema = Schema.Union([
  Schema.Struct({
    type: Schema.Literals(['bold', 'italic', 'underline', 'strikethrough', 'code']),
  }),
  Schema.Struct({ color: Schema.String, type: Schema.Literal('foregroundColor') }),
  Schema.Struct({ color: Schema.String, type: Schema.Literal('backgroundColor') }),
  Schema.Struct({ href: Schema.String, type: Schema.Literal('link') }),
]);

export const coreReferenceSchema = Schema.Struct({
  entityId: Schema.String,
  entityType: Schema.String,
  kind: Schema.Literals(['mention', 'relation']),
  lastResolvedLabel: Schema.String,
  ownerModuleKey: Schema.String,
  targetTenantId: Schema.String,
  token: Schema.String,
});

export const textInlineNodeSchema = Schema.Union([
  Schema.Struct({
    marks: Schema.Array(textMarkSchema),
    text: Schema.String,
    type: Schema.Literal('text'),
  }),
  Schema.Struct({ type: Schema.Literal('lineBreak') }),
  Schema.Struct({ expression: Schema.String, type: Schema.Literal('equation') }),
  Schema.Struct({ reference: coreReferenceSchema, type: Schema.Literal('reference') }),
]);

export const textDocumentSchema = Schema.Struct({
  content: Schema.Array(textInlineNodeSchema),
  type: Schema.Literal('textDocument'),
});

export const nullableTextDocumentSchema = Schema.Union([Schema.Null, textDocumentSchema]);

export const textPropertyValueSchema = Schema.Struct({
  document: nullableTextDocumentSchema,
  propertyDefinitionId: Schema.String,
  readableText: Schema.Union([Schema.Null, Schema.String]),
  revision: Schema.Finite,
});

export type TextMark = typeof textMarkSchema.Type;
export type CoreReference = typeof coreReferenceSchema.Type;
export type TextInlineNode = typeof textInlineNodeSchema.Type;
export type TextDocument = typeof textDocumentSchema.Type;
export type TextPropertyValue = typeof textPropertyValueSchema.Type;
