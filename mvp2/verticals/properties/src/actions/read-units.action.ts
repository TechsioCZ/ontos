import { unitReadPayloadSchema, unitReadResultSchema } from '../../shared/effect/api.ts';

export const readUnitsActionDescriptor = {
  actionKey: 'property.registry.readUnits',
  auditProfile: 'standard',
  gatewayAudience: 'properties',
  idempotency: 'optional',
  requestSchema: unitReadPayloadSchema,
  responseSchema: unitReadResultSchema,
} as const;

export type ReadUnitsAction = typeof unitReadPayloadSchema.Type;
