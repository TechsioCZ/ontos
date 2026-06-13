import { defineVerticalAction } from '@mvp/shared-contracts';
import { Schema } from '@modern-js/plugin-bff/effect-client';

export const propertyUnitCreatePayloadSchema = Schema.Struct({
  displayName: Schema.String,
  floorLabel: Schema.optional(Schema.String),
  tenantModuleState: Schema.optional(Schema.String),
});

export const propertyUnitCreateResultSchema = Schema.Struct({
  actionId: Schema.Literal('property.registry.createUnit'),
  didWriteCanonicalRows: Schema.Literal(false),
  moduleId: Schema.Literal('property.registry'),
  resourceId: Schema.Literal('property.unit'),
  status: Schema.Literal('not_implemented'),
  unitId: Schema.String,
});

export type PropertyUnitCreatePayload = typeof propertyUnitCreatePayloadSchema.Type;
export type PropertyUnitCreateResult = typeof propertyUnitCreateResultSchema.Type;

export const createUnitAction = defineVerticalAction({
  key: 'property.registry.createUnit',
  label: 'Create property unit',
  requestSchema: propertyUnitCreatePayloadSchema,
  responseSchema: propertyUnitCreateResultSchema,
  targetModuleId: 'property.registry',
  writesCanonicalRows: false,
});

export const createUnitActionDescriptor = createUnitAction;
