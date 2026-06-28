import { defineOutboxMessage } from '@mvp2/core-runtime';
import { propertiesUnitCreatedTopic } from '@mvp2/shared-contracts/properties-events';
import type { PropertiesUnitCreatedPayload } from '@mvp2/shared-contracts/properties-events';

export const propertiesUnitCreatedOutboxMessage = defineOutboxMessage(
  propertiesUnitCreatedTopic,
)<PropertiesUnitCreatedPayload>;
