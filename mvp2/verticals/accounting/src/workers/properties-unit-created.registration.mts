import type { OutboxWorkerRegistration } from '@mvp2/core-runtime';
import type { PropertiesUnitCreatedPayload } from '@mvp2/shared-contracts/properties-events';
import { propertiesUnitCreatedWorkerHandler } from './properties-unit-created.handler.mts';
import { propertiesUnitCreatedWorkerDescriptor } from './properties-unit-created.worker.mts';

export const propertiesUnitCreatedWorkerRegistration = {
  descriptor: propertiesUnitCreatedWorkerDescriptor,
  handler: propertiesUnitCreatedWorkerHandler,
} satisfies OutboxWorkerRegistration<PropertiesUnitCreatedPayload>;
