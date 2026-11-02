import { coreSearchIngestionRegistryLayer, defineCoreSearchIngestionRegistrations } from '@app/core-runtime';

export const searchIngestionRegistrations = defineCoreSearchIngestionRegistrations(
  (
    [
      ['property.leasing.search-refresh-requested.v1', 'property.leasing.refresh-search'],
      ['property.leasing.search-rebuild-requested.v1', 'property.leasing.rebuild-search'],
    ] as const
  ).map(([topic, workerKey]) => ({
    consumerModuleKey: 'property.leasing',
    producerModuleKey: 'property.leasing',
    topic,
    workerKey,
  })),
);

export const SearchIngestionRegistryLive = coreSearchIngestionRegistryLayer(searchIngestionRegistrations);
