import { coreSearchIngestionRegistryLayer, defineCoreSearchIngestionRegistrations } from '@app/core-runtime';

export const merchandiseSearchIngestionRegistrations = defineCoreSearchIngestionRegistrations(
  ['refresh', 'rebuild'].map((kind) => ({
    consumerModuleKey: 'demo.merchandise',
    producerModuleKey: 'demo.merchandise',
    topic: `demo.merchandise.search-${kind}-requested.v1`,
    workerKey: `demo.merchandise.${kind}-search`,
  })),
);
export const MerchandiseSearchIngestionRegistryLive = coreSearchIngestionRegistryLayer(
  merchandiseSearchIngestionRegistrations,
);
