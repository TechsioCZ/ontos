import { fileURLToPath } from 'node:url';

import { NodeFileSystem } from '@effect/platform-node';
import { Effect, FileSystem } from 'effect';
import { expect, it } from 'effect-rstest';

import { outboxWorkers } from '../../src/workers/index.ts';
import { reconcilePriceGroupContainmentProjectionWorker } from '../../src/workers/reconcile-price-group-containment-projection.worker.ts';

const readRelative = (relativePath: string) =>
  FileSystem.FileSystem.use((fileSystem) =>
    fileSystem.readFileString(fileURLToPath(new URL(relativePath, import.meta.url))),
  );

it('registers the durable containment reconciler in both module and process inventories', () => {
  expect(outboxWorkers).toEqual([reconcilePriceGroupContainmentProjectionWorker]);
});

it.layer(NodeFileSystem.layer)(
  'starts a health-gated worker with tenant owner and containment capabilities',
  (suite) => {
    suite.effect('runs inside the shared restart-draining and graceful-shutdown Outbox Worker host', () =>
      Effect.gen(function* productionWorkerHost() {
        const entry = yield* readRelative('../../src/worker-host/entry.ts');
        const layer = yield* readRelative('../../src/worker-host/layer.ts');
        const host = yield* readRelative('../../../../scripts/outbox-worker-host.generated.mts');
        const worker = yield* readRelative('../../src/workers/reconcile-price-group-containment-projection.worker.ts');
        const registration = yield* readRelative('../../vertical.registration.ts');

        expect(entry).toContain('defineOutboxWorkerEntry');
        expect(entry).toContain('extractOutboxWorkerSubscriptions(outboxWorkers)');
        expect(entry).toContain('registrations: outboxWorkers');
        expect(host).toContain('verticals/price-group-catalog/src/worker-host/entry.ts');
        expect(host).toContain('health: true');
        expect(layer).toContain('OutboxWorkerTenantScopeLive');
        expect(layer).toContain('ResourceContainmentRelationshipMutationLive');
        expect(registration).toContain('reconcilePriceGroupContainmentProjectionWorker');
        expect(worker).toContain("legalEntityScope: 'forbidden'");
      }),
    );
  },
);
