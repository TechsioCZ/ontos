import type { AnyOutboxWorkerRegistration } from '@app/core-runtime';

// <generated-outbox-worker-imports>
import { privacyMeasureDispatchWorker } from './privacy-measure-dispatch.worker.ts';
import { retentionEvaluationWorker } from './retention-evaluation.worker.ts';
// </generated-outbox-worker-imports>

export const outboxWorkers = Object.freeze([
  // <generated-outbox-worker-registrations>
  privacyMeasureDispatchWorker,
  retentionEvaluationWorker,
  // </generated-outbox-worker-registrations>
]) satisfies readonly AnyOutboxWorkerRegistration[];
