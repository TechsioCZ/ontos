import type { OutboxWorkerDescriptor } from '@mvp2/core-runtime';
import type { PropertiesUnitCreatedPayload } from '@mvp2/shared-contracts/properties-events';
import { propertiesUnitCreatedTopic } from '@mvp2/shared-contracts/properties-events';

export const propertiesUnitCreatedWorkerDescriptor = {
  workerKey: 'accounting.propertiesUnitCreated',
  owningModuleKey: 'accounting',
  executingModuleKey: 'accounting',
  topics: [propertiesUnitCreatedTopic],
} satisfies OutboxWorkerDescriptor<PropertiesUnitCreatedPayload>;
