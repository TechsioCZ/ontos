import type { AnyOutboxWorkerRegistration } from '@app/core-runtime';

// <generated-outbox-worker-imports>
import { projectMarketActivatedToSearchWorker } from './project-market-activated-to-search.worker.ts';
import { projectMarketCreatedToSearchWorker } from './project-market-created-to-search.worker.ts';
import { projectMarketDefinitionRevisedToSearchWorker } from './project-market-definition-revised-to-search.worker.ts';
import { projectMarketRetiredToSearchWorker } from './project-market-retired-to-search.worker.ts';
import { projectMarketSuspendedToSearchWorker } from './project-market-suspended-to-search.worker.ts';
import { rebuildSearchWorker } from './rebuild-search.worker.ts';
// </generated-outbox-worker-imports>

export const outboxWorkers = Object.freeze([
  // <generated-outbox-worker-registrations>
  projectMarketActivatedToSearchWorker,
  projectMarketCreatedToSearchWorker,
  projectMarketDefinitionRevisedToSearchWorker,
  projectMarketRetiredToSearchWorker,
  projectMarketSuspendedToSearchWorker,
  rebuildSearchWorker,
  // </generated-outbox-worker-registrations>
]) satisfies readonly AnyOutboxWorkerRegistration[];
