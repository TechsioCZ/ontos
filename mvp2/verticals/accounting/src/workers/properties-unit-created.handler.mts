import type { OutboxWorkerHandler } from '@mvp2/core-runtime';
import type { PropertiesUnitCreatedPayload } from '@mvp2/shared-contracts/properties-events';

export const propertiesUnitCreatedWorkerHandler: OutboxWorkerHandler<
  PropertiesUnitCreatedPayload
> = () => {
  // PoC proof handler: accounting subscribes to properties.unit.created without materializing yet.
};
