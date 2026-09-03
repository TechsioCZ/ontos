import type { AnyOutboxWorkerRegistration } from '@app/core-runtime';

// <generated-outbox-worker-imports>
import { projectContactPointAddedToSearchWorker } from './project-contact-point-added-to-search.worker.ts';
import { projectContactPointEndedToSearchWorker } from './project-contact-point-ended-to-search.worker.ts';
import { projectContactPointUpdatedToSearchWorker } from './project-contact-point-updated-to-search.worker.ts';
import { projectCounterpartyCreatedToSearchWorker } from './project-counterparty-created-to-search.worker.ts';
import { projectCounterpartyRoleAddedToSearchWorker } from './project-counterparty-role-added-to-search.worker.ts';
import { projectCounterpartyRoleEndedToSearchWorker } from './project-counterparty-role-ended-to-search.worker.ts';
import { projectOfficialIdentifierAddedToSearchWorker } from './project-official-identifier-added-to-search.worker.ts';
import { projectOfficialIdentifierEndedToSearchWorker } from './project-official-identifier-ended-to-search.worker.ts';
import { projectOfficialIdentifierUpdatedToSearchWorker } from './project-official-identifier-updated-to-search.worker.ts';
import { projectPartyArchivedToSearchWorker } from './project-party-archived-to-search.worker.ts';
import { projectPartyCreatedToSearchWorker } from './project-party-created-to-search.worker.ts';
import { projectPartyFactCorrectedToSearchWorker } from './project-party-fact-corrected-to-search.worker.ts';
import { projectPartyUnarchivedToSearchWorker } from './project-party-unarchived-to-search.worker.ts';
import { projectPartyUpdatedToSearchWorker } from './project-party-updated-to-search.worker.ts';
import { rebuildSearchWorker } from './rebuild-search.worker.ts';
// </generated-outbox-worker-imports>

export const outboxWorkers = Object.freeze([
  // <generated-outbox-worker-registrations>
  projectContactPointAddedToSearchWorker,
  projectContactPointEndedToSearchWorker,
  projectContactPointUpdatedToSearchWorker,
  projectCounterpartyCreatedToSearchWorker,
  projectCounterpartyRoleAddedToSearchWorker,
  projectCounterpartyRoleEndedToSearchWorker,
  projectOfficialIdentifierAddedToSearchWorker,
  projectOfficialIdentifierEndedToSearchWorker,
  projectOfficialIdentifierUpdatedToSearchWorker,
  projectPartyArchivedToSearchWorker,
  projectPartyCreatedToSearchWorker,
  projectPartyFactCorrectedToSearchWorker,
  projectPartyUnarchivedToSearchWorker,
  projectPartyUpdatedToSearchWorker,
  rebuildSearchWorker,
  // </generated-outbox-worker-registrations>
]) satisfies readonly AnyOutboxWorkerRegistration[];
