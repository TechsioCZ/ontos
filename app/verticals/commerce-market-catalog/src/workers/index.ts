import type { AnyOutboxWorkerRegistration } from '@app/core-runtime';

// <generated-outbox-worker-imports>
import { completeMarketRetirementWorker } from './complete-market-retirement.worker.ts';
import { projectAssociationContainmentWorker } from './project-association-containment.worker.ts';
import { projectMarketContainmentWorker } from './project-market-containment.worker.ts';
// </generated-outbox-worker-imports>

export const outboxWorkers = Object.freeze([
  // <generated-outbox-worker-registrations>
  completeMarketRetirementWorker,
  projectAssociationContainmentWorker,
  projectMarketContainmentWorker,
  // </generated-outbox-worker-registrations>
]) satisfies readonly AnyOutboxWorkerRegistration[];
