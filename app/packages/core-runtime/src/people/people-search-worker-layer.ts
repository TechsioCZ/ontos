import {
  projectPeopleLifecycleSearchSubscription,
  projectPeopleRoleSearchSubscription,
  rebuildPeopleSearchSubscription,
} from './people-search-subscriptions.ts';

export const peopleSearchSubscriptions = Object.freeze([
  projectPeopleLifecycleSearchSubscription,
  projectPeopleRoleSearchSubscription,
  rebuildPeopleSearchSubscription,
]);
export const peopleSearchIngestionRegistrations = Object.freeze(
  peopleSearchSubscriptions.map(({ consumerModuleKey, producerModuleKey, topic, workerKey }) => ({
    consumerModuleKey,
    producerModuleKey,
    topic,
    workerKey,
  })),
);
export { PeopleSearchProjectorLive } from './people-search-projection.ts';
export { PeopleSearchSourceLive } from './people-search-source.ts';
export { PeopleSearchVisibilityLive } from './people-search-visibility.ts';
