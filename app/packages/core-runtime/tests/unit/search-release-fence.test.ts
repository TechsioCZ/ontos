import { Effect, Predicate } from 'effect';
import { expect, it } from 'effect-rstest';

import { attestOutboxWorkerHandlerContext } from '../../src/outbox/definition.ts';
import { makePostgresCoreSearchProjectionStore } from '../../src/search/persistence.ts';
import {
  makeCoreSearchWorkerSnapshot,
  makePostgresCoreSearchSnapshotBackend,
} from '../../src/search/worker-snapshot.ts';
import { makeTestDatabase } from '../support/database.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const revision = 'a'.repeat(64);
const context = attestOutboxWorkerHandlerContext({
  attemptNumber: 1,
  claimId: 'claim-1',
  compositionRevision: revision,
  consumerModuleKey: 'party.registry',
  deliveryId: 'delivery-1',
  domainEventId: 'event-1',
  legalEntityScope: 'forbidden',
  messageId: 'message-1',
  producerModuleKey: 'party.registry',
  tenantId,
  tenantSequenceNo: 2n,
  topic: 'party.registry.party-updated.v1',
  workerKey: 'party.registry.project-party-updated-to-search',
});
const document = {
  archived: false,
  facets: [],
  metadata: [],
  projectionVersion: '1',
  ref: {
    moduleId: 'party.registry',
    resourceId: 'party-1',
    resourceType: 'party.registry.party',
    tenantId,
  },
  searchableText: ['Acme'],
  title: 'Acme',
};

it.effect('native projection writes retain the worker release fence through each transaction', () =>
  Effect.gen(function* fenceNativeProjectionWrites() {
    let activeRevision = revision;
    const statements: string[] = [];
    const executor = yield* makeTestDatabase((statement) => {
      statements.push(statement);
      if (statement.includes("current_setting('transaction_isolation')")) {
        return Effect.succeed([{ isolation: 'read committed' }]);
      }
      if (statement.includes('from "core"."application_composition_authority"')) {
        return Effect.succeed([{ phase: 'active', revision: activeRevision, subscriptionsJson: [], unexpired: true }]);
      }
      if (statement.includes('as tenant_id') && statement.includes('as legal_entity_id')) {
        return Effect.succeed([{ legal_entity_id: '', tenant_id: tenantId }]);
      }
      return Effect.succeed([]);
    });
    const store = makePostgresCoreSearchProjectionStore({ executor });
    yield* store.apply({ document, kind: 'upsert' }, context);
    yield* store.replace(
      {
        documents: [document],
        moduleId: 'party.registry',
        rebuildVersion: '1',
        resourceType: 'party.registry.party',
        tenantId,
      },
      context,
    );
    expect(statements.filter((statement) => statement.includes('pg_advisory_xact_lock_shared')).length).toBe(2);
    expect(statements.some((statement) => statement.startsWith('insert into "core"."search_index_entries"'))).toBe(
      true,
    );
    activeRevision = 'b'.repeat(64);
    const beforeStale = statements.length;
    for (const write of [
      store.apply({ document: { ...document, projectionVersion: '2' }, kind: 'upsert' }, context),
      store.replace(
        {
          documents: [],
          moduleId: 'party.registry',
          rebuildVersion: '2',
          resourceType: 'party.registry.party',
          tenantId,
        },
        context,
      ),
    ]) {
      const failure = yield* Effect.flip(write);
      expect(Predicate.isTagged(failure, 'CoreSearchProjectionUnavailable')).toBe(true);
    }
    expect(statements.slice(beforeStale).some((statement) => /^(?:insert|update|delete) /u.test(statement))).toBe(
      false,
    );
    expect(statements.slice(beforeStale).filter((statement) => /^rollback$/iu.test(statement)).length).toBe(2);
  }),
);

it.effect('the native generation CAS rereads owner data after a competing generation commits', () =>
  Effect.gen(function* retryNativeGenerationClaim() {
    let generation = 0n;
    let reads = 0;
    let generationWrites = 0;
    const executor = yield* makeTestDatabase((statement) => {
      if (statement.includes("current_setting('transaction_isolation')")) {
        return Effect.succeed([{ isolation: 'read committed' }]);
      }
      if (statement.includes('from "core"."application_composition_authority"')) {
        return Effect.succeed([{ phase: 'draining', revision, subscriptionsJson: [], unexpired: true }]);
      }
      if (statement.includes('as tenant_id') && statement.includes('as legal_entity_id')) {
        return Effect.succeed([{ legal_entity_id: '', tenant_id: tenantId }]);
      }
      if (statement.includes('max(') && statement.includes('"domain_events"')) {
        return Effect.succeed([{ version: '2' }]);
      }
      if (statement.includes('from "core"."search_projection_generations"')) {
        return Effect.succeed(generation === 0n ? [] : [{ version: generation.toString() }]);
      }
      if (statement.startsWith('insert into "core"."search_projection_generations"')) {
        generationWrites += 1;
        generation += 1n;
      }
      return Effect.succeed([]);
    });
    const reader = makeCoreSearchWorkerSnapshot(makePostgresCoreSearchSnapshotBackend({ executor }));
    const result = yield* reader.read(context, (snapshot) => {
      reads += 1;
      if (reads === 1) {
        generation = 1n;
      }
      return Effect.succeed({ read: reads, version: snapshot.projectionVersion });
    });
    expect(result).toEqual({ read: 2, version: '2' });
    expect(generationWrites).toBe(1);
    expect(generation).toBe(2n);
  }),
);

it.effect('a coherent read remains read-only and its generation cannot commit after promotion', () =>
  Effect.gen(function* rejectLateSnapshotClaim() {
    let activeRevision = revision;
    const statements: string[] = [];
    const executor = yield* makeTestDatabase((statement) => {
      statements.push(statement);
      if (statement.includes("current_setting('transaction_isolation')")) {
        return Effect.succeed([{ isolation: 'read committed' }]);
      }
      if (statement.includes('from "core"."application_composition_authority"')) {
        return Effect.succeed([{ phase: 'active', revision: activeRevision, subscriptionsJson: [], unexpired: true }]);
      }
      if (statement.includes('as tenant_id') && statement.includes('as legal_entity_id')) {
        return Effect.succeed([{ legal_entity_id: '', tenant_id: tenantId }]);
      }
      if (statement.includes('max(') && statement.includes('"domain_events"')) {
        return Effect.succeed([{ version: '2' }]);
      }
      return Effect.succeed([]);
    });
    const reader = makeCoreSearchWorkerSnapshot(makePostgresCoreSearchSnapshotBackend({ executor }));
    const failure = yield* Effect.flip(
      reader.read(context, (snapshot) => {
        expect(snapshot.projectionVersion).toBe('1');
        activeRevision = 'b'.repeat(64);
        return Effect.succeed('coherent old-release data');
      }),
    );
    expect(Predicate.isTagged(failure, 'CoreSearchProjectionUnavailable')).toBe(true);
    expect(
      statements.some((statement) => statement.includes('repeatable read') && statement.includes('read only')),
    ).toBe(true);
    expect(
      statements.some((statement) => statement.startsWith('insert into "core"."search_projection_generations"')),
    ).toBe(false);
    activeRevision = revision;
    const beforeFailedRead = statements.length;
    const ownerFailure = yield* Effect.flip(reader.read(context, () => Effect.fail('owner-read-unavailable')));
    expect(ownerFailure).toBe('owner-read-unavailable');
    expect(
      statements.slice(beforeFailedRead).some((statement) => statement.includes('pg_advisory_xact_lock_shared')),
    ).toBe(false);
    expect(statements.slice(beforeFailedRead).some((statement) => /^(?:insert|update|delete) /u.test(statement))).toBe(
      false,
    );
  }),
);
