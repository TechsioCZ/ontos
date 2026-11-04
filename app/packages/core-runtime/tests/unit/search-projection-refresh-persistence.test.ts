import { Effect, Predicate, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { attestOutboxWorkerHandlerContext } from '../../src/outbox/definition.ts';
import { makePostgresCoreSearchProjectionStore } from '../../src/search/persistence.ts';
import type { CoreSearchPersistedPayloadSchema } from '../../src/search/persistence.ts';
import { defineCoreSearchIngestionRegistrations } from '../../src/search/ingestion-registry.ts';
import {
  makeCoreSearchWorkerSnapshot,
  makePostgresCoreSearchSnapshotBackend,
} from '../../src/search/worker-snapshot.ts';
import { makeTestDatabase } from '../support/database.ts';
import { FIXTURE_DATABASE_IDENTITY_ENROLLMENT } from '../support/database-identities.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const selectedLegalEntityId = '20000000-0000-4000-8000-000000000001';
const moduleId = 'demo.tasks';
const revision = 'a'.repeat(64);
const context = attestOutboxWorkerHandlerContext({
  attemptNumber: 1,
  claimId: 'claim-1',
  compositionRevision: revision,
  consumerModuleKey: moduleId,
  deliveryId: 'delivery-1',
  domainEventId: 'event-1',
  legalEntityScope: 'forbidden',
  messageId: 'message-1',
  producerModuleKey: 'party.registry',
  tenantId,
  tenantSequenceNo: 1n,
  topic: 'party.registry.party-updated.v1',
  workerKey: 'demo.tasks.refresh-party-labels',
});
type SearchPayloadFixture = Partial<typeof CoreSearchPersistedPayloadSchema.Encoded>;
// Explicit driver-column order is independent of object-key sorting. The scripted PgClient
// converts positional rows with Object.values, just like its object fixtures.
const driverRow = (facetsJson?: SearchPayloadFixture) => [
  // searchIndexEntryId
  '60000000-0000-4000-8000-000000000001',
  tenantId,
  selectedLegalEntityId,
  moduleId,
  'demo.tasks.task',
  'one',
  // title
  'Task one',
  // bodyText
  'task one',
  // searchTextV1
  null,
  // searchFormatVersion
  null,
  // searchSourceVersion
  null,
  // deleted
  false,
  facetsJson ?? { schemaVersion: '2' },
  // projectionVersion
  '1',
  // createdAt
  '2026-11-04T00:00:00Z',
  // updatedAt
  '2026-11-04T00:00:00Z',
];
const malformedRow = driverRow();
const input = {
  moduleId,
  selectedLegalEntityId,
  sourceRef: {
    moduleId: 'party.registry',
    resourceId: 'party-1',
    resourceType: 'party.registry.party',
    tenantId,
  },
  tenantId,
};

it.effect(
  'native reverse lookup is fenced and restricts the complete scan to its consumer, tenant, company and canonical source',
  () =>
    Effect.gen(function* queryScopedDependencies() {
      const statements: string[] = [];
      const parameters: (readonly unknown[])[] = [];
      const executor = yield* makeTestDatabase((statement, params) => {
        statements.push(statement);
        parameters.push(params);
        if (statement.includes("current_setting('transaction_isolation')")) {
          return Effect.succeed([{ isolation: 'read committed' }]);
        }
        if (statement.includes('from "core"."application_composition_authority"')) {
          return Effect.succeed([{ phase: 'active', revision, subscriptionsJson: [], unexpired: true }]);
        }
        if (statement.includes('as tenant_id') && statement.includes('as legal_entity_id')) {
          return Effect.succeed([{ legal_entity_id: '', tenant_id: tenantId }]);
        }
        return Effect.succeed([]);
      });
      const store = makePostgresCoreSearchProjectionStore({ executor }, FIXTURE_DATABASE_IDENTITY_ENROLLMENT);
      expect(yield* store.queryDependents(input, context)).toEqual([]);
      const offset = statements.findIndex((statement) => statement.includes('from "core"."search_index_entries"'));
      const statement = statements[offset];
      const params = parameters[offset];
      expect(statement).toContain("->'labelDependencies' @>");
      expect(statement).toContain('"source_module_key" =');
      expect(statement).toContain('"tenant_id" =');
      expect(statement).toContain('"legal_entity_id" =');
      expect(statement).toContain('"deleted" =');
      expect(params).toContain(moduleId);
      expect(params).toContain(tenantId);
      expect(params).toContain(selectedLegalEntityId);
      expect(params).toContain(10_001);
      const expectedPredicate = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Json))([
        { ref: input.sourceRef, selectedLegalEntityId },
      ]);
      expect(params).toContain(expectedPredicate);
      expect(statements.filter((sql) => sql.includes('pg_advisory_xact_lock_shared')).length).toBe(1);
    }),
);

it.effect('native refresh rejects older source evidence even under a newer target projection version', () =>
  Effect.gen(function* preserveNativeSourceRevision() {
    const statements: string[] = [];
    const currentPayload: SearchPayloadFixture = {
      archived: false,
      facets: [],
      labelDependencies: [{ ref: input.sourceRef, selectedLegalEntityId, sourceRevision: '2' }],
      metadata: [],
      schemaVersion: '2',
      searchableText: [],
    };
    const executor = yield* makeTestDatabase((statement) => {
      statements.push(statement);
      if (statement.includes("current_setting('transaction_isolation')")) {
        return Effect.succeed([{ isolation: 'read committed' }]);
      }
      if (statement.includes('from "core"."application_composition_authority"')) {
        return Effect.succeed([{ phase: 'active', revision, subscriptionsJson: [], unexpired: true }]);
      }
      if (statement.includes('as tenant_id') && statement.includes('as legal_entity_id')) {
        return Effect.succeed([{ legal_entity_id: '', tenant_id: tenantId }]);
      }
      return Effect.succeed(
        statement.includes('from "core"."search_index_entries"') ? [driverRow(currentPayload)] : [],
      );
    });
    const store = makePostgresCoreSearchProjectionStore({ executor }, FIXTURE_DATABASE_IDENTITY_ENROLLMENT);
    const failure = yield* Effect.flip(
      store.applyBatch(
        {
          moduleId,
          mutations: [
            {
              document: {
                archived: false,
                facets: [],
                labelDependencies: [{ ref: input.sourceRef, selectedLegalEntityId, sourceRevision: '1' }],
                metadata: [],
                projectionVersion: '2',
                ref: { moduleId, resourceId: 'one', resourceType: 'demo.tasks.task', tenantId },
                searchableText: ['Old withdrawn label'],
                selectedLegalEntityId,
                title: 'Task one',
              },
              kind: 'upsert',
            },
          ],
          tenantId,
        },
        context,
      ),
    );
    expect(Predicate.isTagged(failure, 'CoreSearchProjectionInvalid')).toBe(true);
    expect(failure.reason).toContain('roll back a source label revision');
    expect(statements.some((sql) => /^(?:insert|update|delete) /u.test(sql))).toBe(false);
    expect(statements.some((sql) => /^rollback$/iu.test(sql))).toBe(true);
  }),
);

it.effect('foreign-source snapshot generations belong to the consumer, not the source publisher', () =>
  Effect.gen(function* isolateConsumerGeneration() {
    const generationParameters: (readonly unknown[])[] = [];
    const executor = yield* makeTestDatabase((statement, params) => {
      if (
        statement.includes('"search_projection_generations"') ||
        statement.includes('pg_advisory_xact_lock(hashtextextended')
      ) {
        generationParameters.push(params);
      }
      if (statement.includes("current_setting('transaction_isolation')")) {
        return Effect.succeed([{ isolation: 'read committed' }]);
      }
      if (statement.includes('from "core"."application_composition_authority"')) {
        return Effect.succeed([{ phase: 'active', revision, subscriptionsJson: [], unexpired: true }]);
      }
      if (statement.includes('as tenant_id') && statement.includes('as legal_entity_id')) {
        return Effect.succeed([{ legal_entity_id: '', tenant_id: tenantId }]);
      }
      if (statement.includes('max(') && statement.includes('"domain_events"')) {
        return Effect.succeed([{ version: '1' }]);
      }
      return Effect.succeed([]);
    });
    const registrations = defineCoreSearchIngestionRegistrations([
      {
        consumerModuleKey: moduleId,
        producerModuleKey: context.producerModuleKey,
        topic: context.topic,
        workerKey: context.workerKey,
      },
    ]);
    const reader = makeCoreSearchWorkerSnapshot(makePostgresCoreSearchSnapshotBackend({ executor }), registrations);
    expect(yield* reader.read(context, (snapshot) => Effect.succeed(snapshot.projectionVersion))).toBe('1');
    expect(generationParameters.length).toBe(4);
    expect(generationParameters.every((params) => !params.includes('party.registry'))).toBe(true);
    expect(generationParameters.filter((params) => params.includes(moduleId)).length).toBe(3);
    expect(
      generationParameters.some((params) => params.includes(`ontos.search-generation:${tenantId}:${moduleId}`)),
    ).toBe(true);
  }),
);

it.effect(
  'native reverse lookup rejects overflow or malformed rows rather than returning a truncated dependency page',
  () =>
    Effect.gen(function* rejectIncompleteDependencies() {
      for (const rows of [Array.from({ length: 10_001 }, () => malformedRow), [malformedRow]]) {
        const executor = yield* makeTestDatabase((statement) => {
          if (statement.includes("current_setting('transaction_isolation')")) {
            return Effect.succeed([{ isolation: 'read committed' }]);
          }
          if (statement.includes('from "core"."application_composition_authority"')) {
            return Effect.succeed([{ phase: 'active', revision, subscriptionsJson: [], unexpired: true }]);
          }
          if (statement.includes('as tenant_id') && statement.includes('as legal_entity_id')) {
            return Effect.succeed([{ legal_entity_id: '', tenant_id: tenantId }]);
          }
          return Effect.succeed(statement.includes('from "core"."search_index_entries"') ? rows : []);
        });
        const store = makePostgresCoreSearchProjectionStore({ executor }, FIXTURE_DATABASE_IDENTITY_ENROLLMENT);
        const failure = yield* Effect.flip(store.queryDependents(input, context));
        expect(Predicate.isTagged(failure, 'CoreSearchProjectionUnavailable')).toBe(true);
      }
    }),
);
