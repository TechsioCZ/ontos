import { expect, it } from 'effect-rstest';
import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { DateTime, Effect, Option, Schema } from 'effect';
import { makeCoreDatabase } from '../../src/db/client.ts';
import { loadDatabaseConfig } from '../../src/db/config.ts';
import {
  actionInvocations,
  domainEvents,
  legalEntities,
  outboxAttempts,
  outboxDeliveries,
  outboxMessages,
  principals,
  tenantModuleStates,
  tenants,
} from '../../src/db/schema.ts';
import { defineTenantModuleEntrypoint } from '../../src/modules/module-entrypoint.ts';
import { defineOutboxWorker } from '../../src/outbox/definition.ts';
import { makeOutboxRepository } from '../../src/outbox/repository.ts';

const MergeIdSchema = Schema.String.pipe(Schema.brand('OutboxWorkerActorEvidenceMergeId'));
const payloadSchema = Schema.Struct({ mergeId: MergeIdSchema });

it.live('derives worker actor evidence from the exact same-Tenant Action invocation', () =>
  Effect.gen(function* workerActorEvidenceIntegration() {
    const tenantId = randomUUID();
    const legalEntityId = randomUUID();
    const principalId = randomUUID();
    const configuration = yield* loadDatabaseConfig();
    const { executor } = yield* makeCoreDatabase(configuration);
    const cleanup = Effect.gen(function* cleanupWorkerActorEvidence() {
      const messages = yield* executor
        .select({ messageId: outboxMessages.outboxMessageId })
        .from(outboxMessages)
        .where(eq(outboxMessages.tenantId, tenantId));
      const messageIds = messages.map(({ messageId }) => messageId);
      const deliveries = yield* executor
        .select({ deliveryId: outboxDeliveries.outboxDeliveryId })
        .from(outboxDeliveries)
        .where(inArray(outboxDeliveries.outboxMessageId, messageIds));
      yield* executor.delete(outboxAttempts).where(
        inArray(
          outboxAttempts.outboxDeliveryId,
          deliveries.map(({ deliveryId }) => deliveryId),
        ),
      );
      yield* executor.delete(outboxDeliveries).where(inArray(outboxDeliveries.outboxMessageId, messageIds));
      yield* executor.delete(outboxMessages).where(eq(outboxMessages.tenantId, tenantId));
      yield* executor.delete(domainEvents).where(eq(domainEvents.tenantId, tenantId));
      yield* executor.delete(actionInvocations).where(eq(actionInvocations.tenantId, tenantId));
      yield* executor.delete(tenantModuleStates).where(eq(tenantModuleStates.tenantId, tenantId));
      yield* executor.delete(principals).where(eq(principals.tenantId, tenantId));
      yield* executor.delete(legalEntities).where(eq(legalEntities.tenantId, tenantId));
      yield* executor.delete(tenants).where(eq(tenants.tenantId, tenantId));
    });
    yield* Effect.acquireRelease(cleanup, () => cleanup.pipe(Effect.orDie));
    yield* executor.insert(tenants).values({
      defaultLocale: 'en',
      name: 'Worker actor evidence',
      slug: `worker-actor-${tenantId}`,
      status: 'active',
      tenantId,
    });
    yield* executor.insert(legalEntities).values({
      legalEntityId,
      legalName: 'Worker actor legal entity',
      registrationCountry: 'CZ',
      registrationNumber: `WORKER-ACTOR-${legalEntityId}`,
      status: 'active',
      tenantId,
    });
    yield* executor.insert(principals).values({
      displayName: 'Worker actor',
      kind: 'human',
      principalId,
      status: 'active',
      tenantId,
    });
    const invocation = Option.getOrThrow(
      Option.fromNullishOr(
        (yield* executor
          .insert(actionInvocations)
          .values({
            actionKey: 'party.registry.merge-party',
            authMethod: 'session',
            correlationId: 'merge-correlation-1',
            legalEntityId,
            principalId,
            requestHash: 'request-hash',
            status: 'succeeded',
            tenantId,
          })
          .returning({ actionInvocationId: actionInvocations.actionInvocationId }))[0],
      ),
    );
    const event = Option.getOrThrow(
      Option.fromNullishOr(
        (yield* executor
          .insert(domainEvents)
          .values({
            actionInvocationId: invocation.actionInvocationId,
            eventType: 'PartyMerged',
            legalEntityId,
            payloadJson: { mergeId: 'merge-1' },
            producerModuleKey: 'party.registry',
            subjectModuleKey: 'party.registry',
            subjectResourceId: 'merge-1',
            subjectResourceType: 'party-merge',
            tenantId,
          })
          .returning({ domainEventId: domainEvents.domainEventId }))[0],
      ),
    );
    yield* executor.insert(outboxMessages).values({
      domainEventId: event.domainEventId,
      payloadJson: { mergeId: 'merge-1' },
      producerModuleKey: 'party.registry',
      tenantId,
      topic: 'party.registry.party-merged.v1',
    });
    yield* executor.insert(tenantModuleStates).values({
      moduleKey: 'commerce.customer-context',
      state: 'active',
      tenantId,
    });
    const registration = defineOutboxWorker(
      {
        consumerModuleKey: 'commerce.customer-context',
        entrypoint: defineTenantModuleEntrypoint({
          access: 'background',
          authorization: { kind: 'owner_local_background' },
          entrypointKey: 'commerce.customer-context.reconcile-party-merge',
          moduleKey: 'commerce.customer-context',
          role: 'worker',
        }),
        leaseDurationMs: 30_000,
        payloadSchema,
        producerModuleKey: 'party.registry',
        retryPolicy: {
          initialBackoffMs: 1000,
          maxAttempts: 5,
          maxBackoffMs: 60_000,
          multiplier: 2,
        },
        topic: 'party.registry.party-merged.v1',
        workerKey: 'commerce.customer-context.reconcile-party-merge',
      },
      () => Effect.void,
    );
    const repository = makeOutboxRepository(executor);
    const now = yield* DateTime.nowAsDate;
    yield* repository.matchUnmatched([registration.descriptor], now);
    const claimAt = DateTime.makeUnsafe(now).pipe(DateTime.add({ milliseconds: 1000 }), DateTime.toDateUtc);
    const claimed = Option.getOrThrow(yield* repository.claimNext([registration], 'worker-actor-evidence', claimAt));
    expect(claimed.actorPrincipalId).toBe(principalId);
    expect(claimed.correlationId).toBe('merge-correlation-1');
    return yield* Effect.void;
  }),
);
