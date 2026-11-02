import { coreSearchIngestionRegistryLayer, defineCoreSearchIngestionRegistrations } from '@app/core-runtime';

export const facilitySearchIngestionRegistrations = defineCoreSearchIngestionRegistrations(
  ['refresh', 'rebuild'].map((kind) => ({
    consumerModuleKey: 'facility.operations',
    producerModuleKey: 'facility.operations',
    topic: `facility.operations.search-${kind}-requested.v1`,
    workerKey: `facility.operations.${kind}-search`,
  })),
);
export const FacilitySearchIngestionRegistryLive = coreSearchIngestionRegistryLayer(
  facilitySearchIngestionRegistrations,
);
