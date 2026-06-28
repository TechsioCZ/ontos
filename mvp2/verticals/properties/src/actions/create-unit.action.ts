import type { ActionDescriptor } from '@mvp2/core-runtime';
import { unitCreatePayloadSchema, unitCreateResultSchema } from '../../shared/effect/api.ts';

export type CreateUnitAction = typeof unitCreatePayloadSchema.Type;
export type CreateUnitResult = typeof unitCreateResultSchema.Type;

export const createUnitActionDescriptor = {
  actionKey: 'property.registry.createUnit',
  auditProfile: 'standard',
  domainEvent: {
    eventType: 'properties.unit.created',
    payload: (input, response) => ({
      name: input,
      unitId: response.unitId,
    }),
    producerModuleKey: 'properties',
    subjectModuleKey: 'properties',
    subjectResourceId: (_input, response) => response.unitId,
    subjectResourceType: 'property.unit',
  },
  gatewayAudience: 'properties',
  idempotency: 'required',
  moduleStateAccess: 'mutate',
  requestSchema: unitCreatePayloadSchema,
  responseSchema: unitCreateResultSchema,
} satisfies ActionDescriptor<CreateUnitAction, CreateUnitResult>;
