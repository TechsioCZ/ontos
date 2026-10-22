import { coreSearchIngestionRegistryLayer, defineCoreSearchIngestionRegistrations } from '@app/core-runtime';

const MODULE_KEY = 'party.registry';

/** Each Party lifecycle topic (and the explicit rebuild request) paired with the self-consumer projecting it to search. */
const PARTY_SEARCH_TOPIC_WORKERS = [
  ['party.registry.party-created.v1', 'party.registry.project-party-created-to-search'],
  ['party.registry.party-updated.v1', 'party.registry.project-party-updated-to-search'],
  ['party.registry.party-archived.v1', 'party.registry.project-party-archived-to-search'],
  ['party.registry.party-unarchived.v1', 'party.registry.project-party-unarchived-to-search'],
  ['party.registry.party-fact-corrected.v1', 'party.registry.project-party-fact-corrected-to-search'],
  ['party.registry.official-identifier-added.v1', 'party.registry.project-official-identifier-added-to-search'],
  ['party.registry.official-identifier-updated.v1', 'party.registry.project-official-identifier-updated-to-search'],
  ['party.registry.official-identifier-ended.v1', 'party.registry.project-official-identifier-ended-to-search'],
  ['party.registry.contact-point-added.v1', 'party.registry.project-contact-point-added-to-search'],
  ['party.registry.contact-point-updated.v1', 'party.registry.project-contact-point-updated-to-search'],
  ['party.registry.contact-point-ended.v1', 'party.registry.project-contact-point-ended-to-search'],
  ['party.registry.counterparty-created.v1', 'party.registry.project-counterparty-created-to-search'],
  ['party.registry.counterparty-role-added.v1', 'party.registry.project-counterparty-role-added-to-search'],
  ['party.registry.counterparty-role-ended.v1', 'party.registry.project-counterparty-role-ended-to-search'],
  ['party.registry.search-rebuild-requested.v1', 'party.registry.rebuild-search'],
] as const;

/** The Core Search ingestion registrations Party Registry declares for its own post-commit projections. */
export const partySearchIngestionRegistrations = defineCoreSearchIngestionRegistrations(
  PARTY_SEARCH_TOPIC_WORKERS.map(([topic, workerKey]) => ({
    consumerModuleKey: MODULE_KEY,
    producerModuleKey: MODULE_KEY,
    topic,
    workerKey,
  })),
);

export const PartySearchIngestionRegistryLive = coreSearchIngestionRegistryLayer(partySearchIngestionRegistrations);
