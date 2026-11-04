import { defineCoreSearchIngestionRegistrations } from '@app/core-runtime';
import {
  outboxProducerModuleKey as refreshProducer,
  outboxTopic as refreshTopic,
} from '../../shared/outbox/demo-workforce-search-refresh-requested-v1.ts';
import {
  outboxProducerModuleKey as rebuildProducer,
  outboxTopic as rebuildTopic,
} from '../../shared/outbox/demo-workforce-search-rebuild-requested-v1.ts';

/** Explicit owner-local snapshot admission; no ambient registry or cross-owner discovery. */
export const workforceSearchIngestionRegistrations = defineCoreSearchIngestionRegistrations([
  {
    consumerModuleKey: 'demo.workforce',
    producerModuleKey: refreshProducer,
    topic: refreshTopic,
    workerKey: 'demo.workforce.refresh-search',
  },
  {
    consumerModuleKey: 'demo.workforce',
    producerModuleKey: rebuildProducer,
    topic: rebuildTopic,
    workerKey: 'demo.workforce.rebuild-search',
  },
]);
