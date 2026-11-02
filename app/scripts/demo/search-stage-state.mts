#!/usr/bin/env node
import { NodeRuntime, NodeServices } from '@effect/platform-node';
import { and, count, eq, inArray, isNull, max, sql } from 'drizzle-orm';
import { Config, Console, DateTime, Effect, Schema } from 'effect';

import { CoreDatabase } from '../../packages/core-runtime/src/db/client.ts';
import {
  outboxDeliveries,
  outboxMessages,
  searchIndexEntries,
  searchProjectionGenerations,
  searchProjectionRebuilds,
} from '../../packages/core-runtime/src/db/schema.ts';
import { listDeadOutboxDeliveries } from '../../packages/core-runtime/src/outbox/dead-delivery-resolution.ts';
import { ApplicationCompositionAuthorityAdminDatabaseLive } from '../application-composition-authority-publication.mts';

export const searchStageOwners = [
  'party.registry',
  'demo.crm',
  'demo.sales-pipeline',
  'demo.merchandise',
  'work.tasks',
  'finance.billing',
  'legal.agreements',
  'property.portfolio',
  'property.leasing',
  'facility.operations',
  'commerce.market-catalog',
  'core.identity',
] as const;

/** Exact producers and topics, not substring matches against unrelated owner work. */
export const searchStageTopics = searchStageOwners.flatMap((owner) => {
  if (owner === 'core.identity') {
    return ['people-search-rebuild-requested', 'principal-lifecycle-changed', 'scoped-role-membership-changed'].map(
      (event) => `${owner}.${event}.v1`,
    );
  }
  if (owner === 'party.registry') {
    return [
      'search-rebuild-requested',
      'party-created',
      'party-updated',
      'party-archived',
      'party-unarchived',
      'party-fact-corrected',
      'counterparty-created',
      'counterparty-role-added',
      'counterparty-role-ended',
      'contact-point-added',
      'contact-point-updated',
      'contact-point-ended',
      'official-identifier-added',
      'official-identifier-updated',
      'official-identifier-ended',
    ].map((event) => `${owner}.${event}.v1`);
  }
  return [`${owner}.search-changed.v1`, `${owner}.search-rebuild-requested.v1`, `${owner}.search-refresh-requested.v1`];
});

export class SearchStageStateError extends Schema.TaggedError<SearchStageStateError>()('SearchStageStateError', {
  reason: Schema.String,
}) {}

const ModuleKey = Schema.String.pipe(Schema.brand('SearchStageModuleKey'));
const MessageId = Schema.String.check(Schema.isUUID()).pipe(Schema.brand('SearchStageMessageId'));
const TenantId = Schema.String.check(Schema.isUUID()).pipe(Schema.brand('SearchStageTenantId'));
const WorkerKey = Schema.String.pipe(Schema.brand('SearchStageWorkerKey'));
const StateSchema = Schema.Struct({
  capturedAt: Schema.DateTimeUtc,
  deadListMayBeTruncated: Schema.Boolean,
  deadSearchDeliveries: Schema.Array(
    Schema.Struct({
      attemptsCount: Schema.Number,
      consumerModuleKey: ModuleKey,
      lastError: Schema.OptionFromNullOr(Schema.String),
      outboxMessageId: MessageId,
      tenantId: TenantId,
      workerKey: WorkerKey,
    }),
  ),
  documents: Schema.Array(
    Schema.Struct({ count: Schema.Number, deleted: Schema.Boolean, owner: Schema.String, resourceType: Schema.String }),
  ),
  generations: Schema.Array(Schema.Struct({ generation: Schema.String, owner: Schema.String, tenantId: TenantId })),
  outbox: Schema.Array(
    Schema.Struct({
      count: Schema.Number,
      maxAttempts: Schema.OptionFromNullOr(Schema.Number),
      owner: Schema.String,
      status: Schema.String,
      topic: Schema.String,
      workerKey: WorkerKey,
    }),
  ),
  rebuilds: Schema.Array(
    Schema.Struct({
      fingerprint: Schema.String,
      owner: Schema.String,
      resourceType: Schema.String,
      tenantId: TenantId,
      version: Schema.String,
    }),
  ),
  unmatched: Schema.Array(Schema.Struct({ count: Schema.Number, owner: Schema.String, topic: Schema.String })),
});

export const readSearchStageState = Effect.gen(function* readSearchStageState() {
  const environment = yield* Config.String('ULTRAMODERN_DEPLOYMENT_ENVIRONMENT');
  const origin = yield* Config.String('ONTOS_PUBLIC_ORIGIN');
  if (environment !== 'stage' || origin !== 'https://ontos-stage.web-revolution.cz') {
    return yield* new SearchStageStateError({ reason: 'Search rollout inspection requires the exact stage target' });
  }
  const database = yield* CoreDatabase;
  const producers = [...searchStageOwners];
  const topics = [...searchStageTopics];
  const outbox = yield* database.executor
    .select({
      count: count(),
      maxAttempts: max(outboxDeliveries.attemptsCount),
      owner: outboxDeliveries.consumerModuleKey,
      status: outboxDeliveries.status,
      topic: outboxMessages.topic,
      workerKey: outboxDeliveries.workerKey,
    })
    .from(outboxDeliveries)
    .innerJoin(outboxMessages, eq(outboxMessages.outboxMessageId, outboxDeliveries.outboxMessageId))
    .where(and(inArray(outboxMessages.producerModuleKey, producers), inArray(outboxMessages.topic, topics)))
    .groupBy(
      outboxDeliveries.consumerModuleKey,
      outboxDeliveries.workerKey,
      outboxDeliveries.status,
      outboxMessages.topic,
    );
  const unmatched = yield* database.executor
    .select({ count: count(), owner: outboxMessages.producerModuleKey, topic: outboxMessages.topic })
    .from(outboxMessages)
    .where(
      and(
        inArray(outboxMessages.producerModuleKey, producers),
        inArray(outboxMessages.topic, topics),
        isNull(outboxMessages.matchedAt),
      ),
    )
    .groupBy(outboxMessages.producerModuleKey, outboxMessages.topic);
  const generations = yield* database.executor
    .select({
      generation: sql<string>`${searchProjectionGenerations.generation}::text`,
      owner: searchProjectionGenerations.sourceModuleKey,
      tenantId: searchProjectionGenerations.tenantId,
    })
    .from(searchProjectionGenerations)
    .where(inArray(searchProjectionGenerations.sourceModuleKey, producers));
  const rebuilds = yield* database.executor
    .select({
      fingerprint: searchProjectionRebuilds.fingerprint,
      owner: searchProjectionRebuilds.sourceModuleKey,
      resourceType: searchProjectionRebuilds.sourceResourceType,
      tenantId: searchProjectionRebuilds.tenantId,
      version: sql<string>`${searchProjectionRebuilds.rebuildVersion}::text`,
    })
    .from(searchProjectionRebuilds)
    .where(inArray(searchProjectionRebuilds.sourceModuleKey, producers));
  const documents = yield* database.executor
    .select({
      count: count(),
      deleted: searchIndexEntries.deleted,
      owner: searchIndexEntries.sourceModuleKey,
      resourceType: searchIndexEntries.sourceResourceType,
    })
    .from(searchIndexEntries)
    .where(inArray(searchIndexEntries.sourceModuleKey, producers))
    .groupBy(searchIndexEntries.sourceModuleKey, searchIndexEntries.sourceResourceType, searchIndexEntries.deleted);
  const dead = yield* listDeadOutboxDeliveries(database.executor, { limit: 500 });
  return yield* Schema.decodeUnknownEffect(StateSchema)({
    capturedAt: yield* DateTime.now,
    deadListMayBeTruncated: dead.length === 500,
    deadSearchDeliveries: dead
      .filter((delivery) =>
        producers.some(
          (owner) =>
            delivery.consumerModuleKey === owner &&
            delivery.workerKey.startsWith(`${owner}.`) &&
            delivery.workerKey.includes('search'),
        ),
      )
      .map(({ attemptsCount, consumerModuleKey, lastError, outboxMessageId, tenantId, workerKey }) => ({
        attemptsCount,
        consumerModuleKey,
        lastError,
        outboxMessageId,
        tenantId,
        workerKey,
      })),
    documents,
    generations,
    outbox,
    rebuilds,
    unmatched,
  });
});

if (import.meta.main) {
  NodeRuntime.runMain(
    readSearchStageState.pipe(
      Effect.flatMap(Schema.encodeEffect(Schema.fromJsonString(StateSchema))),
      Effect.flatMap(Console.log),
      Effect.provide(ApplicationCompositionAuthorityAdminDatabaseLive),
      Effect.provide(NodeServices.layer),
    ),
  );
}
