import type { OutboxWorkerDescriptor } from '@mvp2/core-runtime';

export const propertiesUnitCreatedTopic = 'properties.unit.created';

export const propertiesUnitCreatedWorkerDescriptor = {
  workerKey: 'accounting.propertiesUnitCreated',
  owningModuleKey: 'accounting',
  executingModuleKey: 'accounting',
  topics: [propertiesUnitCreatedTopic],
} satisfies OutboxWorkerDescriptor<unknown>;
