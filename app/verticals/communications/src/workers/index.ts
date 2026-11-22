import type { AnyOutboxWorkerRegistration } from '@app/core-runtime';

// <generated-outbox-worker-imports>
import { prepareMessageHandoffWorker } from './prepare-message-handoff.worker.ts';
import { receivePrivacyMeasureWorker } from './receive-privacy-measure.worker.ts';
import { reportPrivacyOwnerOutcomeWorker } from './report-privacy-owner-outcome.worker.ts';
// </generated-outbox-worker-imports>

export const outboxWorkers = Object.freeze([
  // <generated-outbox-worker-registrations>
  prepareMessageHandoffWorker,
  receivePrivacyMeasureWorker,
  reportPrivacyOwnerOutcomeWorker,
  // </generated-outbox-worker-registrations>
]) satisfies readonly AnyOutboxWorkerRegistration[];
