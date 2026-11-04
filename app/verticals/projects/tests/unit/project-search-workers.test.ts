import {
  CoreSearchIngestion,
  CoreSearchQuerySchema,
  CoreSearchWorkerSnapshot,
  makeCoreSearchIngestion,
  makeInMemoryCoreSearchProjectionStore,
} from '@app/core-runtime';
import type { CoreSearchWorkerSnapshotService, OutboxWorkerHandlerContext } from '@app/core-runtime';
import {
  attestOutboxWorkerHandlerContext,
  invokeRegisteredOutboxWorkerHandler,
} from '@app/core-runtime/testing/outbox';
import { scriptedPgClientLayer, testSqlConnection } from '@app/core-runtime/testing/scripted-pg-client';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import { Array as EffectArray, Effect, Layer, Order, Schema, Struct } from 'effect';
import { Reactivity } from 'effect/reactivity';
import { expect, it } from 'effect-rstest';
import { ProjectSearchRequestIdSchema } from '../../shared/actions/request-search-rebuild.ts';
import { requestSearchRebuildAction } from '../../src/actions/request-search-rebuild.action.ts';
import { projectsRelations } from '../../src/db/schema.ts';
import { projectSearchIngestionRegistrations } from '../../src/search/projects.provider.ts';
import type { ProjectSearchMetadata } from '../../src/services/project-persistence.service.ts';
import { outboxWorkerEntry } from '../../src/worker-host/entry.ts';
import { outboxWorkers } from '../../src/workers/index.ts';
import { rebuildSearchWorker } from '../../src/workers/rebuild-search.worker.ts';
import { refreshSearchWorker } from '../../src/workers/refresh-search.worker.ts';
import { creatorId, tenantId } from '../support/project.ts';

const projectModuleKey = 'projects.core';
const requestId = ProjectSearchRequestIdSchema.make('60000000-0000-4000-8000-000000000001');
const scope = {
  authBindingId: '40000000-0000-4000-8000-000000000001',
  authContextRef: 'better-auth-session:projects-worker-binding',
  authMethod: 'session',
  correlationId: 'projects-worker-binding',
  principalId: creatorId,
  tenantId,
} as const;

/**
 * Public Core surfaces assert the compiled registry (`outboxWorkers`), each registration's descriptor
 * identity and the ingestion admission Core validates before publishing. Core deliberately keeps the
 * handler off the public `OutboxWorkerRegistration` type ("Internal Core seam. Worker handlers are
 * absent from public registrations."), so the registry -> handler dispatch is asserted through the
 * test-only `invokeRegisteredOutboxWorkerHandler` adapter: it resolves the handler the registration
 * actually binds and decodes the payload with the descriptor schema. The effect tests below therefore
 * prove the real projector/ingestion pipeline, its negative guards and the registration's own handler
 * binding together.
 */
const workers = [
  { kind: 'refresh', registration: refreshSearchWorker },
  { kind: 'rebuild', registration: rebuildSearchWorker },
] as const;

const workerContext = (kind: 'refresh' | 'rebuild'): OutboxWorkerHandlerContext =>
  attestOutboxWorkerHandlerContext({
    attemptNumber: 1,
    claimId: `projects-claim-${kind}`,
    compositionRevision: 'a'.repeat(64),
    consumerModuleKey: projectModuleKey,
    deliveryId: `projects-delivery-${kind}`,
    domainEventId: `projects-event-${kind}`,
    legalEntityScope: 'forbidden',
    messageId: `projects-message-${kind}`,
    producerModuleKey: projectModuleKey,
    tenantId,
    tenantSequenceNo: 1n,
    topic: `projects.core.search-${kind}-requested.v1`,
    workerKey: `projects.core.${kind}-search`,
  });

const row = (index: number, name: string): ProjectSearchMetadata => ({
  lifecycleState: index === 2 ? 'archived' : 'active',
  name,
  prefix: 'ONTO',
  projectId: `30000000-0000-4000-8000-00000000000${index}`,
  tenantId,
});

it('admits exactly both generated self-consuming workers with explicit tenant-wide snapshot scope', () => {
  expect(outboxWorkers).toEqual([rebuildSearchWorker, refreshSearchWorker]);
  const declared = workers.map(({ registration }) =>
    Struct.pick(registration.descriptor, ['consumerModuleKey', 'producerModuleKey', 'topic', 'workerKey']),
  );
  expect(projectSearchIngestionRegistrations).toEqual(declared);
  expect(Object.isFrozen(projectSearchIngestionRegistrations)).toBe(true);
  for (const { registration } of workers) {
    expect(registration.descriptor.legalEntityScope).toBe('forbidden');
    expect(registration.descriptor.entrypoint.authorization).toEqual({ kind: 'owner_local_background' });
    expect(registration.descriptor.entrypoint.entrypointKey).toBe(registration.descriptor.workerKey);
    expect(registration.descriptor.consumerModuleKey).toBe(projectModuleKey);
    expect(registration.descriptor.producerModuleKey).toBe(projectModuleKey);
  }
});

it('hosts exactly both generated workers under the Projects claim owner', () => {
  expect(outboxWorkerEntry.claimOwnerPrefix).toBe('projects.core-outbox-worker');
  expect(outboxWorkerEntry.registrations).toBe(workers.length);
});

it('the explicit rebuild Action stays an idempotent, explicitly provisioned, tenant-scoped request', () => {
  const { descriptor } = requestSearchRebuildAction;
  expect(descriptor.actionKey).toBe('projects.core.request-search-rebuild');
  expect(descriptor.owningModuleKey).toBe(projectModuleKey);
  expect(descriptor.idempotency).toBe('required');
  expect(descriptor.legalEntityScope).toBe('optional');
  expect(descriptor.entrypoint.authorization).toEqual({ kind: 'action_execution', provisioning: 'explicit' });
});

for (const { kind, registration } of workers) {
  it.effect(
    `${kind} worker handler delegates to the real projector and publishes only after its source transaction closes`,
    () =>
      Effect.gen(function* workerDelegation() {
        const context = workerContext(kind);
        const rows: readonly ProjectSearchMetadata[] = [row(1, 'Alpha Project'), row(2, 'Beta Project')];
        let reading = false;
        let version = 0;
        const connection = testSqlConnection((_sql, params) => {
          expect(reading).toBe(true);
          expect(params).toEqual([tenantId]);
          return Effect.succeed(rows);
        });
        const sqlLayer = scriptedPgClientLayer(Effect.succeed(connection)).pipe(Layer.provide(Reactivity.layer));
        const executor = yield* makeWithDefaults({ relations: projectsRelations }).pipe(Effect.provide(sqlLayer));
        const reader: CoreSearchWorkerSnapshotService = {
          read: (claim, use) =>
            Effect.suspend(() => {
              expect(claim).toBe(context);
              version += 1;
              reading = true;
              return use({
                eventWatermark: String(version),
                forLegalEntity: () => Effect.die('Tenant Projects must not fan out across companies'),
                legalEntityIds: [],
                projectionVersion: String(version),
                tenant: (read) => read({ select: executor.select.bind(executor) }),
                tenantId,
              }).pipe(
                Effect.ensuring(
                  Effect.sync(() => {
                    reading = false;
                  }),
                ),
              );
            }),
        };
        const store = makeInMemoryCoreSearchProjectionStore();
        let writes = 0;
        const ingestion = makeCoreSearchIngestion(
          {
            apply: (input, claim) => {
              expect(reading).toBe(false);
              writes += 1;
              return store.apply(input, claim);
            },
          },
          projectSearchIngestionRegistrations,
        );
        yield* invokeRegisteredOutboxWorkerHandler(registration, { requestId }, context).pipe(
          Effect.provideService(CoreSearchWorkerSnapshot, reader),
          Effect.provideService(CoreSearchIngestion, ingestion),
        );
        expect(writes).toBe(rows.length);
        const query = yield* Schema.decodeUnknownEffect(CoreSearchQuerySchema)({
          includeArchived: true,
          moduleId: projectModuleKey,
          query: 'Project',
          resourceType: 'projects.project',
          tenantId,
        });
        const documents = yield* store.queryCandidates(query, scope);
        expect(
          EffectArray.sort(
            documents.map((document) => document.ref.resourceId),
            Order.String,
          ),
        ).toEqual(
          EffectArray.sort(
            rows.map((current) => current.projectId),
            Order.String,
          ),
        );
        expect(documents.filter((document) => document.archived)).toHaveLength(1);
      }),
  );
}
