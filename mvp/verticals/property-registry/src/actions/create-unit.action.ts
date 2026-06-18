import { defineVerticalAction } from '@mvp/shared-contracts';
import { Schema } from '@modern-js/plugin-bff/effect-client';

export const propertyUnitCreatePayloadSchema = Schema.Struct({
  name: Schema.String,
});

export const propertyUnitCreateResultSchema = Schema.Struct({
  actionId: Schema.Literal('property.registry.createUnit'),
  didWriteCanonicalRows: Schema.Literal(true),
  moduleId: Schema.Literal('property.registry'),
  resourceId: Schema.Literal('property.unit'),
  resourceRef: Schema.Struct({
    moduleId: Schema.Literal('property.registry'),
    resourceId: Schema.Literal('property.unit'),
    resourceKey: Schema.String,
  }),
  status: Schema.Literal('created'),
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
  writesCanonicalRows: true,
});

export const createUnitActionDescriptor = createUnitAction;
