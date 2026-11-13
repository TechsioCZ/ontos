/**
 * Core's own Outbox work must be claimable in a tenant that has no module state for `core.authorization`, because
 * Core is not an installable tenant module and nothing ever writes such a row. A tenant module's worker must still
 * wait for its module to be installed and background-eligible.
 *
 * Without the claim-eligibility fix these two expectations collapse into one: every core-system delivery stays
 * `pending` with zero attempts for ever, which is what stopped a stage Outbox drain from finishing.
 */
import { applicationCompositionContentRevision } from '@app/core-runtime';
import { NodeChildProcessSpawner, NodeServices } from '@effect/platform-node';
import { and, eq } from 'drizzle-orm';
import { Crypto, DateTime, Effect, Layer, Option } from 'effect';
import { expect, it } from 'effect-rstest';

import { makeCoreDatabase } from '../../packages/core-runtime/src/db/client.ts';
import {
  domainEvents,
  outboxDeliveries,
  outboxMessages,
  tenantModuleStates,
  tenants,
} from '../../packages/core-runtime/src/db/schema.ts';
import {
  ActiveApplicationCompositionService,
  validateActiveApplicationCompositionSnapshot,
} from '../../packages/core-runtime/src/modules/active-application-composition.ts';
import { corePrincipalLifecycleSubscription } from '../../packages/core-runtime/src/outbox/core-system-subscriptions.ts';
import { coreSystemOutboxWorkers } from '../../packages/core-runtime/src/outbox/core-system-worker-entry.ts';
import { makeOutboxRepository } from '../../packages/core-runtime/src/outbox/repository.ts';
import { withWorkerRuntimeBinding } from '../../packages/core-runtime/src/outbox/worker-runtime-binding.ts';
import { makeIsolatedNativeDatabaseFixture } from '../../packages/core-runtime/src/testing/isolated-native-database.ts';
import { makeApplicationCompositionSnapshotFixture } from '../../packages/core-runtime/src/testing/module-contract.ts';

const services = NodeChildProcessSpawner.layer.pipe(Layer.provideMerge(NodeServices.layer));
const FIXTURE_NAME = 'core-system-drain';
const CLAIM_OWNER = `${FIXTURE_NAME}-claimer`;

/** An isolated database with a published composition, one active tenant and one unmatched core-system message. */
const fixture = Effect.gen(function* coreSystemDrainFixture() {
  const isolated = yield* makeIsolatedNativeDatabaseFixture({
    mode: 'empty',
    purpose: 'publication-drain-core-system',
  });
  yield* isolated.migrateCoreSchema();
  const base = yield* makeApplicationCompositionSnapshotFixture([FIXTURE_NAME], FIXTURE_NAME);
  const snapshot = yield* validateActiveApplicationCompositionSnapshot({
    ...base,
    composition: {
      ...base.composition,
      revision: yield* applicationCompositionContentRevision(base.composition),
    },
  });
  yield* isolated.publishInitialComposition(snapshot);
  const { executor: runtime } = yield* makeCoreDatabase(isolated.connections.runtime);
  const tenantId = yield* Crypto.Crypto.use((crypto) => crypto.randomUUIDv4());
  yield* runtime.insert(tenants).values({
    defaultLocale: 'en',
    name: 'Core system drain fixture',
    slug: `${FIXTURE_NAME}-${tenantId}`,
    status: 'active',
    tenantId,
  });
  // Deliberately no `core.authorization` module state: no product code ever writes one, exactly as on stage.
  const { revision } = snapshot.composition;
  yield* runtime.transaction(
    Effect.fn(function* acceptPrincipalLifecycleWork(transaction) {
      const [event] = yield* transaction
        .insert(domainEvents)
        .values({
          eventType: corePrincipalLifecycleSubscription.topic,
          payloadJson: {},
          producerModuleKey: corePrincipalLifecycleSubscription.producerModuleKey,
          subjectModuleKey: corePrincipalLifecycleSubscription.producerModuleKey,
          subjectResourceId: tenantId,
          subjectResourceType: 'principal',
          tenantId,
        })
        .returning({ id: domainEvents.domainEventId });
      const [message] = yield* transaction
        .insert(outboxMessages)
        .values({
          domainEventId: Option.getOrThrow(Option.fromNullishOr(event)).id,
          payloadJson: { data: { principalId: tenantId, state: 'disabled', tenantId }, schemaVersion: 1 },
          producerModuleKey: corePrincipalLifecycleSubscription.producerModuleKey,
          tenantId,
          topic: corePrincipalLifecycleSubscription.topic,
        })
        .returning({ id: outboxMessages.outboxMessageId });
      return Option.getOrThrow(Option.fromNullishOr(message)).id;
    }),
  );
  const repository = makeOutboxRepository(runtime, yield* Crypto.Crypto);
  yield* repository.matchUnmatched(revision, yield* DateTime.nowAsDate);
  return { repository, revision, runtime, shell: snapshot.composition.shell, snapshot, tenantId };
});

it.layer(services, { excludeTestServices: true })('core-system Outbox claim eligibility', (suite) => {
  suite.effect('claims core lifecycle work in a tenant that has no core module state', () =>
    Effect.gen(function* claimsCoreSystemWork() {
      const f = yield* fixture;
      // Matching the message against the published authority creates the core-system delivery.
      const [delivery] = yield* f.runtime
        .select({ attempts: outboxDeliveries.attemptsCount, status: outboxDeliveries.status })
        .from(outboxDeliveries)
        .where(eq(outboxDeliveries.workerKey, corePrincipalLifecycleSubscription.workerKey));
      expect(delivery).toMatchObject({ attempts: 0, status: 'pending' });
      expect(
        yield* f.runtime
          .select({ moduleKey: tenantModuleStates.moduleKey })
          .from(tenantModuleStates)
          .where(
            and(
              eq(tenantModuleStates.tenantId, f.tenantId),
              eq(tenantModuleStates.moduleKey, corePrincipalLifecycleSubscription.consumerModuleKey),
            ),
          ),
      ).toHaveLength(0);

      // The genuine Core registrations, bound to the composition's own Shell deployment, as the host binds them.
      const claim = yield* withWorkerRuntimeBinding(
        {
          authority: { load: Effect.succeed(f.snapshot) },
          expectedDeployment: f.shell.deployment,
          registrations: coreSystemOutboxWorkers,
        },
        f.repository.claimNext(coreSystemOutboxWorkers, CLAIM_OWNER, yield* DateTime.nowAsDate, f.revision),
      ).pipe(Effect.provideService(ActiveApplicationCompositionService, { load: Effect.succeed(f.snapshot) }));
      expect(Option.isSome(claim)).toBe(true);
      expect(Option.getOrThrow(claim).workerKey).toBe(corePrincipalLifecycleSubscription.workerKey);
    }),
  );
});
