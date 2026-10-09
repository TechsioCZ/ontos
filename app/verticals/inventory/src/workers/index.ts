import type { AnyOutboxWorkerRegistration } from '@app/core-runtime';

// <generated-outbox-worker-imports>
import { executeCommitmentProtectionEstablishmentWorker } from './execute-commitment-protection-establishment.worker.ts';
import { executeInventoryReservationCreateWorker } from './execute-inventory-reservation-create.worker.ts';
import { executeInventoryReservationReleaseWorker } from './execute-inventory-reservation-release.worker.ts';
import { executeReservationConfirmationIssuanceWorker } from './execute-reservation-confirmation-issuance.worker.ts';
import { executeStockIssueWorker } from './execute-stock-issue.worker.ts';
import { executeStockReceiptWorker } from './execute-stock-receipt.worker.ts';
// </generated-outbox-worker-imports>

export const outboxWorkers = Object.freeze([
  // <generated-outbox-worker-registrations>
  executeCommitmentProtectionEstablishmentWorker,
  executeInventoryReservationCreateWorker,
  executeInventoryReservationReleaseWorker,
  executeReservationConfirmationIssuanceWorker,
  executeStockIssueWorker,
  executeStockReceiptWorker,
  // </generated-outbox-worker-registrations>
] as const) satisfies readonly AnyOutboxWorkerRegistration[];
