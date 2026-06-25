// @effect-diagnostics globalConsole:off
import type { OutboxWorkerHandler } from '@mvp2/core-runtime';

export const propertiesUnitCreatedWorkerHandler: OutboxWorkerHandler<unknown> = (input) => {
  console.log('[accounting] properties.unit.created', {
    context: input.context,
    payload: input.payload,
  });
};
