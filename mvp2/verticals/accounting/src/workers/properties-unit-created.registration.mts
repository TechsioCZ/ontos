import type { OutboxWorkerRegistration } from '@mvp2/core-runtime/outbox';
import type { PropertiesUnitCreatedPayload } from '@mvp2/properties/shared/events/properties-unit-created';
import { propertiesUnitCreatedWorkerHandler } from './properties-unit-created.handler.mts';
import { propertiesUnitCreatedWorkerDescriptor } from './properties-unit-created.worker.mts';

export const propertiesUnitCreatedWorkerRegistration = {
  descriptor: propertiesUnitCreatedWorkerDescriptor,
  handler: propertiesUnitCreatedWorkerHandler,
} satisfies OutboxWorkerRegistration<PropertiesUnitCreatedPayload>;
