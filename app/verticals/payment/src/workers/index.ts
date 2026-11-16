import type { AnyOutboxWorkerRegistration } from '@app/core-runtime';

// <generated-outbox-worker-imports>
import { executeGatewayOperationWorker } from './execute-gateway-operation.worker.ts';
import { processProviderNotificationWorker } from './process-provider-notification.worker.ts';
import { recoverGatewayOperationWorker } from './recover-gateway-operation.worker.ts';
// </generated-outbox-worker-imports>

export const outboxWorkers = Object.freeze([
  // <generated-outbox-worker-registrations>
  executeGatewayOperationWorker,
  processProviderNotificationWorker,
  recoverGatewayOperationWorker,
  // </generated-outbox-worker-registrations>
]) satisfies readonly AnyOutboxWorkerRegistration[];
