import { unitCreatePayloadSchema, unitCreateResultSchema } from '../../shared/effect/api.ts';

export const createUnitActionDescriptor = {
  actionKey: 'property.registry.createUnit',
  auditProfile: 'standard',
  gatewayAudience: 'properties',
  idempotency: 'required',
  requestSchema: unitCreatePayloadSchema,
  responseSchema: unitCreateResultSchema,
} as const;

export type CreateUnitAction = typeof unitCreatePayloadSchema.Type;
