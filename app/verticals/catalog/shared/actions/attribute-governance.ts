import { Schema } from 'effect';

import { AttributeDefinitionSchema } from '../domain/attribute-values.ts';
import { ControlledAttributeValueSchema } from '../domain/attribute-vocabulary.ts';
import { ColorLocalizedNamesSchema } from '../domain/color.ts';
import { CatalogRevisionNumberSchema } from '../domain/catalog-revision-reference.ts';
import { ProductReasonSchema } from '../domain/product.ts';
import { AttributeDefinitionRefSchema } from '../resources/attribute-definition.ts';
import { ControlledAttributeValueRefSchema } from '../resources/controlled-attribute-value.ts';

const text = Schema.String.check(Schema.isNonEmpty(), Schema.isTrimmed());
const confirmed = Schema.Literal(true);

/** An identity is assigned by the owner, never supplied by the caller. */
export const CreateAttributeDefinitionPayloadSchema = Schema.Struct({
  controlledValueKind: Schema.optionalKey(Schema.Literals(['GENERAL', 'COLOR', 'SIZE'])),
  label: text,
  levels: AttributeDefinitionSchema.fields.levels,
  meaning: text,
  measurement: AttributeDefinitionSchema.fields.measurement,
  multiplicity: AttributeDefinitionSchema.fields.multiplicity,
  reason: ProductReasonSchema,
  specialStates: AttributeDefinitionSchema.fields.specialStates,
  valueKind: AttributeDefinitionSchema.fields.valueKind,
}).check(
  Schema.makeFilter(({ controlledValueKind, valueKind }) =>
    (valueKind === 'CONTROLLED') === (controlledValueKind !== undefined)
      ? undefined
      : 'Controlled value kind is required only for controlled definitions',
  ),
);
export type CreateAttributeDefinitionPayload = typeof CreateAttributeDefinitionPayloadSchema.Type;

const DefinitionResultSchema = Schema.Struct({
  attributeDefinitionRef: AttributeDefinitionRefSchema,
  revision: CatalogRevisionNumberSchema,
});
export const CreateAttributeDefinitionResultSchema = DefinitionResultSchema;

export const RenameAttributeDefinitionPayloadSchema = Schema.Struct({
  attributeDefinitionRef: AttributeDefinitionRefSchema,
  evidence: text,
  expectedRevision: CatalogRevisionNumberSchema,
  label: text,
  reason: ProductReasonSchema,
  sameMeaning: confirmed,
});
export type RenameAttributeDefinitionPayload = typeof RenameAttributeDefinitionPayloadSchema.Type;
export const RenameAttributeDefinitionResultSchema = Schema.Struct({
  ...DefinitionResultSchema.fields,
  changed: Schema.Boolean,
});

export const CreateControlledAttributeValuePayloadSchema = Schema.Struct({
  attributeDefinitionRef: AttributeDefinitionRefSchema,
  color: ControlledAttributeValueSchema.fields.color,
  label: text,
  meaning: text,
  reason: ProductReasonSchema,
  specialization: ControlledAttributeValueSchema.fields.specialization,
}).check(
  Schema.makeFilter(({ color, specialization }) =>
    (specialization === 'COLOR') === (color !== undefined) ? undefined : 'Color details are required only for Color',
  ),
);
export type CreateControlledAttributeValuePayload = typeof CreateControlledAttributeValuePayloadSchema.Type;

const ControlledValueResultSchema = Schema.Struct({
  controlledValueRef: ControlledAttributeValueRefSchema,
  revision: CatalogRevisionNumberSchema,
});
export const CreateControlledAttributeValueResultSchema = ControlledValueResultSchema;

export const RenameControlledAttributeValuePayloadSchema = Schema.Struct({
  controlledValueRef: ControlledAttributeValueRefSchema,
  evidence: text,
  expectedRevision: CatalogRevisionNumberSchema,
  label: text,
  localizedNames: Schema.optionalKey(ColorLocalizedNamesSchema),
  reason: ProductReasonSchema,
  sameMeaning: confirmed,
});
export type RenameControlledAttributeValuePayload = typeof RenameControlledAttributeValuePayloadSchema.Type;
export const RenameControlledAttributeValueResultSchema = Schema.Struct({
  ...ControlledValueResultSchema.fields,
  changed: Schema.Boolean,
});

export const RetireControlledAttributeValuePayloadSchema = Schema.Struct({
  controlledValueRef: ControlledAttributeValueRefSchema,
  expectedRevision: CatalogRevisionNumberSchema,
  reason: ProductReasonSchema,
});
export type RetireControlledAttributeValuePayload = typeof RetireControlledAttributeValuePayloadSchema.Type;
const ControlledValueLifecycleResultSchema = Schema.Struct({
  ...ControlledValueResultSchema.fields,
  changed: Schema.Boolean,
  lifecycle: Schema.Literals(['ACTIVE', 'RETIRED']),
});
export const RetireControlledAttributeValueResultSchema = ControlledValueLifecycleResultSchema;

export const ReactivateControlledAttributeValuePayloadSchema = Schema.Struct({
  controlledValueRef: ControlledAttributeValueRefSchema,
  currentMeaningConfirmed: confirmed,
  evidence: text,
  expectedRevision: CatalogRevisionNumberSchema,
  reason: ProductReasonSchema,
});
export type ReactivateControlledAttributeValuePayload = typeof ReactivateControlledAttributeValuePayloadSchema.Type;
export const ReactivateControlledAttributeValueResultSchema = ControlledValueLifecycleResultSchema;
