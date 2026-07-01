import type { OutboxWorkerDescriptor } from '@mvp2/core-runtime/outbox';
import {
  propertiesUnitCreatedPayloadSchema,
  propertiesUnitCreatedTopic,
} from '@mvp2/properties/shared/events/properties-unit-created';
import type { PropertiesUnitCreatedPayload } from '@mvp2/properties/shared/events/properties-unit-created';

export const propertiesUnitCreatedWorkerDescriptor = {
  workerKey: 'accounting.propertiesUnitCreated',
  owningModuleKey: 'accounting',
  consumerModuleKey: 'accounting',
  payloadSchema: propertiesUnitCreatedPayloadSchema,
  topics: [propertiesUnitCreatedTopic],
} satisfies OutboxWorkerDescriptor<PropertiesUnitCreatedPayload>;
