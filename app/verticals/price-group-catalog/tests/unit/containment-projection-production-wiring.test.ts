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
    suite.effect('uses the shared restart-draining and graceful-shutdown process host', () =>
      Effect.gen(function* productionWorkerHost() {
        const start = yield* readRelative('../../src/worker-host/start.ts');
        const layer = yield* readRelative('../../src/worker-host/layer.ts');
        const main = yield* readRelative('../../src/worker-host/main.ts');
        const worker = yield* readRelative('../../src/workers/reconcile-price-group-containment-projection.worker.ts');
        const packageJson = yield* readRelative('../../package.json');
        const registration = yield* readRelative('../../vertical.registration.ts');

        expect(start).toContain('startOutboxWorkerProcess');
        expect(start).toContain('extractOutboxWorkerSubscriptions(outboxWorkers)');
        expect(start).toContain('health: true');
        expect(start).toContain('registrations: outboxWorkers');
        expect(layer).toContain('OutboxWorkerTenantScopeLive');
        expect(layer).toContain('ResourceContainmentRelationshipMutationLive');
        expect(main).toContain('startPriceGroupCatalogOutboxWorker()');
        expect(packageJson).toContain('"worker:start": "node --experimental-strip-types ./src/worker-host/main.ts"');
        expect(registration).toContain('reconcilePriceGroupContainmentProjectionWorker');
        expect(worker).toContain("legalEntityScope: 'forbidden'");
      }),
    );
  },
);
