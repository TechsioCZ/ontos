import { defineOutboxMessage } from '@mvp2/core-runtime';

export type PropertiesUnitCreatedPayload = {
  readonly name: string;
  readonly unitId: string;
};

export const propertiesUnitCreatedOutboxMessage = defineOutboxMessage(
  'properties.unit.created',
)<PropertiesUnitCreatedPayload>;
