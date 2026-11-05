import type { AnyOutboxWorkerRegistration } from '@app/core-runtime';

// <generated-outbox-worker-imports>
import { executePrivacyMeasureWorker } from './execute-privacy-measure.worker.ts';
import { reconcilePartyMergeWorker } from './reconcile-party-merge.worker.ts';
// </generated-outbox-worker-imports>

export const outboxWorkers = Object.freeze([
  // <generated-outbox-worker-registrations>
  executePrivacyMeasureWorker,
  reconcilePartyMergeWorker,
  // </generated-outbox-worker-registrations>
]) satisfies readonly AnyOutboxWorkerRegistration[];
