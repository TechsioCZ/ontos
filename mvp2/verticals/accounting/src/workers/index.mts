import type { OutboxWorkerRegistration } from '@mvp2/core-runtime/outbox';
import { propertiesUnitCreatedWorkerRegistration } from './properties-unit-created.registration.mts';

export const accountingOutboxWorkerRegistrations = [
  propertiesUnitCreatedWorkerRegistration,
] satisfies readonly OutboxWorkerRegistration<unknown>[];
