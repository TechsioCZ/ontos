import { coreSearchIngestionRegistryLayer, defineCoreSearchIngestionRegistrations } from '@app/core-runtime';

const moduleKey = 'commerce.market-catalog';

export const marketSearchIngestionRegistrations = defineCoreSearchIngestionRegistrations([
  {
    consumerModuleKey: moduleKey,
    producerModuleKey: moduleKey,
    topic: 'commerce.market-catalog.market-created.v1',
    workerKey: 'commerce.market-catalog.project-market-created-to-search',
  },
  {
    consumerModuleKey: moduleKey,
    producerModuleKey: moduleKey,
    topic: 'commerce.market-catalog.market-definition-revised.v1',
    workerKey: 'commerce.market-catalog.project-market-definition-revised-to-search',
  },
  {
    consumerModuleKey: moduleKey,
    producerModuleKey: moduleKey,
    topic: 'commerce.market-catalog.market-activated.v1',
    workerKey: 'commerce.market-catalog.project-market-activated-to-search',
  },
  {
    consumerModuleKey: moduleKey,
    producerModuleKey: moduleKey,
    topic: 'commerce.market-catalog.market-suspended.v1',
    workerKey: 'commerce.market-catalog.project-market-suspended-to-search',
  },
  {
    consumerModuleKey: moduleKey,
    producerModuleKey: moduleKey,
    topic: 'commerce.market-catalog.market-retired.v1',
    workerKey: 'commerce.market-catalog.project-market-retired-to-search',
  },
  {
    consumerModuleKey: moduleKey,
    producerModuleKey: moduleKey,
    topic: 'commerce.market-catalog.search-rebuild-requested.v1',
    workerKey: 'commerce.market-catalog.rebuild-search',
  },
]);

export const MarketSearchIngestionRegistryLive = coreSearchIngestionRegistryLayer(marketSearchIngestionRegistrations);
