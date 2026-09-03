import { expect, test } from '@rstest/core';
import { buildInstalledModuleCatalog } from '@app/core-runtime';
import { Effect } from 'effect';
import { matchInstalledOutboxMessagesOnce } from '../../api/modules/installed-outbox-matcher.ts';

const contract = (
  appId: string,
  moduleId: string,
  outboxSubscriptions: readonly object[] = [],
) => ({
  deployment: { appId, buildMarker: `${appId}-build` },
  manifest: {
    activation: {
      defaultState: 'inactive',
      preservesHistoryWhenInactive: true,
      scope: 'tenant',
      supportedStates: ['inactive', 'active'],
    },
    module: {
      description: `${moduleId} module`,
      displayName: moduleId,
      id: moduleId,
      implementedAs: 'ultramodern_microvertical',
      kind: 'business_module',
    },
    publicSurface: {
      actions: [],
      api: [],
      components: [],
      events: [],
      reports: [],
      resourceTypes: [],
      search: [],
      shellContributions: {
        mediaAttachments: [],
        navigation: [],
        pages: [],
        publicComponents: [],
        reports: [],
        resourceDetails: [],
        search: [],
        timelines: [],
      },
    },
  },
  runtime: { outboxSubscriptions },
  schemaVersion: '2',
});

test('passes a dormant subscription with an absent producer to Core matching', async () => {
  const subscription = {
    consumerModuleKey: 'property.registry',
    entrypoint: {
      access: 'background',
      authorization: { kind: 'owner_local_background' },
      entrypointKey: 'property.registry.document-projector',
      moduleKey: 'property.registry',
      role: 'worker',
      scope: 'tenant',
    },
    producerModuleKey: 'documents.center',
    topic: 'documents.center.created',
    workerKey: 'property.registry.document-projector',
  } as const;
  const catalog = buildInstalledModuleCatalog([
    {
      contract: contract('property-registry', 'property.registry', [subscription]),
      expectedAppId: 'property-registry',
    },
  ]);
  let received: unknown;
  const result = await Effect.runPromise(
    matchInstalledOutboxMessagesOnce(catalog, (input) => {
      received = input.subscriptions;
      return Effect.succeed({ deliveriesCreated: 1, messagesMatched: 1 });
    }),
  );

  expect(received).toEqual([subscription]);
  expect(result).toEqual({ deliveriesCreated: 1, messagesMatched: 1 });
});
