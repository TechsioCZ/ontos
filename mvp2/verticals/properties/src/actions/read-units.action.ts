import { unitReadPayloadSchema, unitReadResultSchema } from '../../shared/effect/api.ts';

export const readUnitsActionDescriptor = {
  actionKey: 'property.registry.readUnits',
  auditProfile: 'standard',
  authorization: {
    permission: 'read',
    provider: 'spicedb',
    resourceObjectId: 'property.unit',
    resourceObjectType: 'resource_type',
  },
  gatewayAudience: 'properties',
  idempotency: 'optional',
  requestSchema: unitReadPayloadSchema,
  responseSchema: unitReadResultSchema,
} as const;

export type ReadUnitsAction = typeof unitReadPayloadSchema.Type;
