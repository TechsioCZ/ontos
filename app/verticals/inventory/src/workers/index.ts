import type { AnyOutboxWorkerRegistration } from '@app/core-runtime';

// <generated-outbox-worker-imports>
import { executeInventoryReservationCreateWorker } from './execute-inventory-reservation-create.worker.ts';
import { executeInventoryReservationReleaseWorker } from './execute-inventory-reservation-release.worker.ts';
import { executeStockIssueWorker } from './execute-stock-issue.worker.ts';
import { executeStockReceiptWorker } from './execute-stock-receipt.worker.ts';
// </generated-outbox-worker-imports>

export const outboxWorkers = Object.freeze([
  // <generated-outbox-worker-registrations>
  executeInventoryReservationCreateWorker,
  executeInventoryReservationReleaseWorker,
  executeStockIssueWorker,
  executeStockReceiptWorker,
  // </generated-outbox-worker-registrations>
]) satisfies readonly AnyOutboxWorkerRegistration[];
