import type { AnyOutboxWorkerRegistration } from '@app/core-runtime';

// <generated-outbox-worker-imports>
import { draftInvoiceFromWonOpportunityWorker } from './draft-invoice-from-won-opportunity.worker.ts';
import { projectSearchWorker } from './project-search.worker.ts';
import { rebuildSearchWorker } from './rebuild-search.worker.ts';
// </generated-outbox-worker-imports>

export const outboxWorkers = Object.freeze([
  // <generated-outbox-worker-registrations>
  draftInvoiceFromWonOpportunityWorker,
  projectSearchWorker,
  rebuildSearchWorker,
  // </generated-outbox-worker-registrations>
]) satisfies readonly AnyOutboxWorkerRegistration[];
