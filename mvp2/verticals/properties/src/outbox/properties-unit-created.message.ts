import { defineOutboxMessage } from '@mvp2/core-runtime/outbox';
import { propertiesUnitCreatedTopic } from '../../shared/events/properties-unit-created.ts';
import type { PropertiesUnitCreatedPayload } from '../../shared/events/properties-unit-created.ts';

export const propertiesUnitCreatedOutboxMessage = defineOutboxMessage(
  propertiesUnitCreatedTopic,
)<PropertiesUnitCreatedPayload>;
