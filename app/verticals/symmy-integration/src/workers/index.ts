import type { AnyOutboxWorkerRegistration } from '@app/core-runtime';

// <generated-outbox-worker-imports>
import { executeSymmyJobWorker } from './execute-symmy-job.worker.ts';
import { symmyJobPrivacyDispatchWorker } from './symmy-job-privacy-dispatch.worker.ts';
// </generated-outbox-worker-imports>

export const outboxWorkers = Object.freeze([
  // <generated-outbox-worker-registrations>
  executeSymmyJobWorker,
  symmyJobPrivacyDispatchWorker,
  // </generated-outbox-worker-registrations>
]) satisfies readonly AnyOutboxWorkerRegistration[];
