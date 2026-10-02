import { Effect } from 'effect';
import { expect, it } from 'effect-rstest';

import { makeModuleContractFixture } from '../../../../packages/core-runtime/src/testing/module-contract.ts';
import { matchInstalledOutboxMessagesOnce } from '../../api/modules/installed-outbox-matcher.ts';
import { makeInstalledModuleCatalogLoader } from '../../api/modules/installed-module-catalog.ts';
import { makeCompositionSnapshot } from '../fixtures/application-composition.ts';

const contract = (appId: string, moduleId: string, outboxSubscriptions: readonly object[] = []) =>
  makeModuleContractFixture({ appId, moduleId, outboxSubscriptions });

it.effect('retains dormant subscriptions with an absent producer and selects the exact release for Core matching', () =>
  Effect.gen(function* verifyCase1() {
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
    const catalog = yield* makeInstalledModuleCatalogLoader(
      makeCompositionSnapshot([contract('property-registry', 'property.registry', [subscription])]),
    );
    let received: unknown;
    const result = yield* matchInstalledOutboxMessagesOnce(catalog, (input) => {
      received = input;
      return Effect.succeed({ deliveriesCreated: 1, messagesMatched: 1 });
    });

    expect(catalog.outboxSubscriptions).toEqual([subscription]);
    expect(catalog.getByModuleId('documents.center')).toBeUndefined();
    expect(received).toEqual({ compositionRevision: catalog.composition.revision });
    expect(result).toEqual({ deliveriesCreated: 1, messagesMatched: 1 });
  }),
);
