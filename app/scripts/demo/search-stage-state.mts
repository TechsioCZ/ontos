#!/usr/bin/env node
import { NodeRuntime, NodeServices } from '@effect/platform-node';
import { and, count, eq, inArray, isNull, max, or, sql } from 'drizzle-orm';
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
import { CORE_SEARCH_FORMAT_VERSION } from '../../packages/core-runtime/src/search/evidence-codec.ts';
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
  'demo.workforce',
  'projects.core',
] as const;

type SearchStageOwner = (typeof searchStageOwners)[number];
const rebuildTopicWorker = ['search-rebuild-requested', 'rebuild-search'] as const;
const refreshTopicWorkers = [['search-refresh-requested', 'refresh-search'], rebuildTopicWorker] as const;
const changedTopicWorkers = [['search-changed', 'project-search'], rebuildTopicWorker] as const;

/** Read-only mirror of owner-local worker registrations, never imports their private implementations.
 * Empty entries are delivery gaps, not hypothetical producers or proof of an empty source.
 */
const searchStageTopicWorkers = {
  'commerce.market-catalog': [
    ['market-created', 'project-market-created-to-search'],
    ['market-definition-revised', 'project-market-definition-revised-to-search'],
    ['market-activated', 'project-market-activated-to-search'],
    ['market-suspended', 'project-market-suspended-to-search'],
    ['market-retired', 'project-market-retired-to-search'],
    rebuildTopicWorker,
  ],
  'core.identity': [
    ['people-search-rebuild-requested', 'rebuild-people-search'],
    ['principal-lifecycle-changed', 'project-people-lifecycle-search'],
    ['scoped-role-membership-changed', 'project-people-role-search'],
  ],
  'demo.crm': changedTopicWorkers,
  'demo.merchandise': refreshTopicWorkers,
  'demo.sales-pipeline': refreshTopicWorkers,
  'demo.workforce': refreshTopicWorkers,
  'facility.operations': refreshTopicWorkers,
  'finance.billing': changedTopicWorkers,
  'legal.agreements': changedTopicWorkers,
  'party.registry': [
    rebuildTopicWorker,
    ['party-created', 'project-party-created-to-search'],
    ['party-updated', 'project-party-updated-to-search'],
    ['party-archived', 'project-party-archived-to-search'],
    ['party-unarchived', 'project-party-unarchived-to-search'],
    ['party-fact-corrected', 'project-party-fact-corrected-to-search'],
    ['counterparty-created', 'project-counterparty-created-to-search'],
    ['counterparty-role-added', 'project-counterparty-role-added-to-search'],
    ['counterparty-role-ended', 'project-counterparty-role-ended-to-search'],
    ['contact-point-added', 'project-contact-point-added-to-search'],
    ['contact-point-updated', 'project-contact-point-updated-to-search'],
    ['contact-point-ended', 'project-contact-point-ended-to-search'],
    ['official-identifier-added', 'project-official-identifier-added-to-search'],
    ['official-identifier-updated', 'project-official-identifier-updated-to-search'],
    ['official-identifier-ended', 'project-official-identifier-ended-to-search'],
  ],
  'projects.core': [],
  'property.leasing': refreshTopicWorkers,
  'property.portfolio': refreshTopicWorkers,
  'work.tasks': refreshTopicWorkers,
} as const satisfies Record<SearchStageOwner, readonly (readonly [string, string])[]>;

export const searchStageSubscriptions = searchStageOwners.flatMap((owner) =>
  searchStageTopicWorkers[owner].map(([event, worker]) => ({
    consumerModuleKey: owner,
    producerModuleKey: owner,
    topic: `${owner}.${event}.v1`,
    workerKey: `${owner}.${worker}`,
  })),
);
export const searchStageTopics = searchStageSubscriptions.map(({ topic }) => topic);

export class SearchStageStateError extends Schema.TaggedError<SearchStageStateError>()('SearchStageStateError', {
  reason: Schema.String,
}) {}

const ModuleKey = Schema.String.pipe(Schema.brand('SearchStageModuleKey'));
const MessageId = Schema.String.check(Schema.isUUID()).pipe(Schema.brand('SearchStageMessageId'));
const TenantId = Schema.String.check(Schema.isUUID()).pipe(Schema.brand('SearchStageTenantId'));
const WorkerKey = Schema.String.pipe(Schema.brand('SearchStageWorkerKey'));
const DerivedObservationSchema = Schema.Struct({
  liveCount: Schema.Number,
  missingCount: Schema.Number,
  owner: Schema.String,
  resourceType: Schema.String,
  staleCount: Schema.Number,
  tenantId: TenantId,
});
const InventorySchema = Schema.Struct({
  liveCount: Schema.OptionFromNullOr(Schema.Number),
  missingCount: Schema.OptionFromNullOr(Schema.Number),
  owner: Schema.String,
  staleCount: Schema.OptionFromNullOr(Schema.Number),
  status: Schema.Literals([
    'producer_missing',
    'producer_unverified',
    'unobserved',
    'derived_missing',
    'derived_stale',
    'observed_stamps_current',
  ]),
});
type DerivedObservation = Omit<typeof DerivedObservationSchema.Type, 'tenantId'> & { readonly tenantId: string };
type InventoryStatus = typeof InventorySchema.fields.status.Type;

/** Only observed live stamps, not source completeness, deployed registration, delivery or overall readiness.
 * No observed rows means unknown counts, never an invented zero or a successful empty backfill.
 */
export const summarizeSearchStageInventory = (observations: readonly DerivedObservation[]) =>
  searchStageOwners.map((owner) => {
    const rows = observations.filter((row) => row.owner === owner);
    const liveCount = rows.length === 0 ? null : rows.reduce((total, row) => total + row.liveCount, 0);
    const missingCount = rows.length === 0 ? null : rows.reduce((total, row) => total + row.missingCount, 0);
    const staleCount = rows.length === 0 ? null : rows.reduce((total, row) => total + row.staleCount, 0);
    const status: InventoryStatus = (() => {
      if (searchStageTopicWorkers[owner].length === 0) {
        return 'producer_missing';
      }
      // Concurrent Workforce delivery has registered workers; registration alone does not prove
      // implemented handlers, committed producer emission or a deployed/settled projection.
      // Parent must re-admit this owner after its delivery slice, not infer readiness from stamps.
      if (owner === 'demo.workforce') {
        return 'producer_unverified';
      }
      if (liveCount === null || liveCount === 0) {
        return 'unobserved';
      }
      if (missingCount !== null && missingCount > 0) {
        return 'derived_missing';
      }
      if (staleCount !== null && staleCount > 0) {
        return 'derived_stale';
      }
      return 'observed_stamps_current';
    })();
    return { liveCount, missingCount, owner, staleCount, status };
  });

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
  derived: Schema.Array(DerivedObservationSchema),
  derivedFormatVersion: Schema.Number,
  documents: Schema.Array(
    Schema.Struct({ count: Schema.Number, deleted: Schema.Boolean, owner: Schema.String, resourceType: Schema.String }),
  ),
  generations: Schema.Array(Schema.Struct({ generation: Schema.String, owner: Schema.String, tenantId: TenantId })),
  inventory: Schema.Array(InventorySchema),
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
  subscriptions: Schema.Array(
    Schema.Struct({
      consumerModuleKey: ModuleKey,
      producerModuleKey: ModuleKey,
      topic: Schema.String,
      workerKey: WorkerKey,
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
  const topicPredicate = or(
    ...searchStageSubscriptions.map(({ producerModuleKey, topic }) =>
      and(eq(outboxMessages.producerModuleKey, producerModuleKey), eq(outboxMessages.topic, topic)),
    ),
  );
  const deliveryPredicate = or(
    ...searchStageSubscriptions.map(({ consumerModuleKey, producerModuleKey, topic, workerKey }) =>
      and(
        eq(outboxMessages.producerModuleKey, producerModuleKey),
        eq(outboxMessages.topic, topic),
        eq(outboxDeliveries.consumerModuleKey, consumerModuleKey),
        eq(outboxDeliveries.workerKey, workerKey),
      ),
    ),
  );
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
    .where(deliveryPredicate)
    .groupBy(
      outboxDeliveries.consumerModuleKey,
      outboxDeliveries.workerKey,
      outboxDeliveries.status,
      outboxMessages.topic,
    );
  const unmatched = yield* database.executor
    .select({ count: count(), owner: outboxMessages.producerModuleKey, topic: outboxMessages.topic })
    .from(outboxMessages)
    .where(and(topicPredicate, isNull(outboxMessages.matchedAt)))
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
  // Match the indexed-query fallback exactly. Tombstones intentionally have no derived stamps.
  const missingStamp = sql`(${searchIndexEntries.searchTextV1} is null
    or ${searchIndexEntries.searchFormatVersion} is null or ${searchIndexEntries.searchSourceVersion} is null)`;
  const derived = yield* database.executor
    .select({
      liveCount: count(),
      missingCount: sql<number>`count(*) filter (where ${missingStamp})`.mapWith(Number),
      owner: searchIndexEntries.sourceModuleKey,
      resourceType: searchIndexEntries.sourceResourceType,
      staleCount: sql<number>`count(*) filter (where not ${missingStamp}
        and (${searchIndexEntries.searchFormatVersion} <> ${CORE_SEARCH_FORMAT_VERSION}
          or ${searchIndexEntries.searchSourceVersion} <> ${searchIndexEntries.projectionVersion}))`.mapWith(Number),
      tenantId: searchIndexEntries.tenantId,
    })
    .from(searchIndexEntries)
    .where(and(inArray(searchIndexEntries.sourceModuleKey, producers), eq(searchIndexEntries.deleted, false)))
    .groupBy(searchIndexEntries.tenantId, searchIndexEntries.sourceModuleKey, searchIndexEntries.sourceResourceType);
  const dead = yield* listDeadOutboxDeliveries(database.executor, { limit: 500 });
  return yield* Schema.decodeUnknownEffect(StateSchema)({
    capturedAt: yield* DateTime.now,
    deadListMayBeTruncated: dead.length === 500,
    deadSearchDeliveries: dead
      .filter((delivery) =>
        searchStageSubscriptions.some(
          ({ consumerModuleKey, workerKey }) =>
            delivery.consumerModuleKey === consumerModuleKey && delivery.workerKey === workerKey,
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
    derived,
    derivedFormatVersion: CORE_SEARCH_FORMAT_VERSION,
    documents,
    generations,
    inventory: summarizeSearchStageInventory(derived),
    outbox,
    rebuilds,
    subscriptions: searchStageSubscriptions,
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
