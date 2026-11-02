import type { AnyOutboxWorkerRegistration } from '@app/core-runtime';

// <generated-outbox-worker-imports>
import { completeMarketRetirementWorker } from './complete-market-retirement.worker.ts';
import { projectAssociationContainmentWorker } from './project-association-containment.worker.ts';
import { projectMarketActivatedToSearchWorker } from './project-market-activated-to-search.worker.ts';
import { projectMarketContainmentWorker } from './project-market-containment.worker.ts';
import { projectMarketCreatedToSearchWorker } from './project-market-created-to-search.worker.ts';
import { projectMarketDefinitionRevisedToSearchWorker } from './project-market-definition-revised-to-search.worker.ts';
import { projectMarketRetiredToSearchWorker } from './project-market-retired-to-search.worker.ts';
import { projectMarketSuspendedToSearchWorker } from './project-market-suspended-to-search.worker.ts';
import { rebuildSearchWorker } from './rebuild-search.worker.ts';
// </generated-outbox-worker-imports>

export const outboxWorkers = Object.freeze([
  // <generated-outbox-worker-registrations>
  completeMarketRetirementWorker,
  projectAssociationContainmentWorker,
  projectMarketActivatedToSearchWorker,
  projectMarketContainmentWorker,
  projectMarketCreatedToSearchWorker,
  projectMarketDefinitionRevisedToSearchWorker,
  projectMarketRetiredToSearchWorker,
  projectMarketSuspendedToSearchWorker,
  rebuildSearchWorker,
  // </generated-outbox-worker-registrations>
]) satisfies readonly AnyOutboxWorkerRegistration[];
