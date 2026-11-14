import { coreSearchIngestionRegistryLayer, defineCoreSearchIngestionRegistrations } from '@app/core-runtime';

export const searchIngestionRegistrations = defineCoreSearchIngestionRegistrations(
  (
    [
      ['property.portfolio.search-refresh-requested.v1', 'property.portfolio.refresh-search'],
      ['property.portfolio.search-rebuild-requested.v1', 'property.portfolio.rebuild-search'],
    ] as const
  ).map(([topic, workerKey]) => ({
    consumerModuleKey: 'property.portfolio',
    producerModuleKey: 'property.portfolio',
    topic,
    workerKey,
  })),
);

export const SearchIngestionRegistryLive = coreSearchIngestionRegistryLayer(searchIngestionRegistrations);
