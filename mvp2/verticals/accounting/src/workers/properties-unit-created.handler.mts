import type { OutboxWorkerHandler } from '@mvp2/core-runtime/outbox';
import type { PropertiesUnitCreatedPayload } from '@mvp2/properties/shared/events/properties-unit-created';

export const propertiesUnitCreatedWorkerHandler: OutboxWorkerHandler<
  PropertiesUnitCreatedPayload
> = () => {
  // PoC proof handler: accounting subscribes to properties.unit.created without materializing yet.
};
