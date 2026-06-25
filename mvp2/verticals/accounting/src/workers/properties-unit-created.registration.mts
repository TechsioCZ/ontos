import type { OutboxWorkerRegistration } from '@mvp2/core-runtime';
import { propertiesUnitCreatedWorkerHandler } from './properties-unit-created.handler.mts';
import { propertiesUnitCreatedWorkerDescriptor } from './properties-unit-created.worker.mts';

export const propertiesUnitCreatedWorkerRegistration = {
  descriptor: propertiesUnitCreatedWorkerDescriptor,
  handler: propertiesUnitCreatedWorkerHandler,
} satisfies OutboxWorkerRegistration<unknown>;
