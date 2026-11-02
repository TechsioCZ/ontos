import { coreSearchIngestionRegistryLayer, defineCoreSearchIngestionRegistrations } from '@app/core-runtime';

export const searchIngestionRegistrations = defineCoreSearchIngestionRegistrations(
  ['refresh', 'rebuild'].map((kind) => ({
    consumerModuleKey: 'demo.sales-pipeline',
    producerModuleKey: 'demo.sales-pipeline',
    topic: `demo.sales-pipeline.search-${kind}-requested.v1`,
    workerKey: `demo.sales-pipeline.${kind}-search`,
  })),
);
export const SearchIngestionRegistryLive = coreSearchIngestionRegistryLayer(searchIngestionRegistrations);
