import { buildInstalledModuleCatalog } from '@app/core-runtime';
import { runEffectTestPromise } from '@app/core-runtime/testing/effect-runtime';
import { expect, test } from '@rstest/core';
import { Effect } from 'effect';

import { makeModuleContractFixture } from '../../../../packages/core-runtime/src/testing/module-contract.ts';
import { matchInstalledOutboxMessagesOnce } from '../../api/modules/installed-outbox-matcher.ts';

const contract = (
  appId: string,
  moduleId: string,
  outboxSubscriptions: readonly object[] = []
) => makeModuleContractFixture({ appId, moduleId, outboxSubscriptions });

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
      contract: contract('property-registry', 'property.registry', [
        subscription,
      ]),
      expectedAppId: 'property-registry',
    },
  ]);
  let received: unknown;
  const result = await runEffectTestPromise(
    matchInstalledOutboxMessagesOnce(catalog, (input) => {
      received = input.subscriptions;
      return Effect.succeed({ deliveriesCreated: 1, messagesMatched: 1 });
    })
  );

  expect(received).toEqual([subscription]);
  expect(result).toEqual({ deliveriesCreated: 1, messagesMatched: 1 });
});
