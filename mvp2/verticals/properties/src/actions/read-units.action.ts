import type { ActionDescriptor } from '@mvp2/core-runtime';
import { unitReadPayloadSchema, unitReadResultSchema } from '../../shared/effect/api.ts';

export type ReadUnitsAction = typeof unitReadPayloadSchema.Type;
export type ReadUnitsResult = typeof unitReadResultSchema.Type;

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
  moduleStateAccess: 'read',
  requestSchema: unitReadPayloadSchema,
  responseSchema: unitReadResultSchema,
} satisfies ActionDescriptor<ReadUnitsAction, ReadUnitsResult>;
