import { coreSearchIngestionRegistryLayer, defineCoreSearchIngestionRegistrations } from '@app/core-runtime';

export const searchIngestionRegistrations = defineCoreSearchIngestionRegistrations(
  ['refresh', 'rebuild'].map((kind) => ({
    consumerModuleKey: 'work.tasks',
    producerModuleKey: 'work.tasks',
    topic: `work.tasks.search-${kind}-requested.v1`,
    workerKey: `work.tasks.${kind}-search`,
  })),
);
export const SearchIngestionRegistryLive = coreSearchIngestionRegistryLayer(searchIngestionRegistrations);
