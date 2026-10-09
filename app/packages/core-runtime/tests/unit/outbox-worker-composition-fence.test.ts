import { Context, Effect, Layer, Predicate } from 'effect';
import { expect, it } from 'effect-rstest';

import { CoreDatabase } from '../../src/db/client.ts';
import { attestOutboxWorkerHandlerContext } from '../../src/outbox/definition.ts';
import {
  makeOutboxWorkerLegalEntityScopeFanout,
  makePostgresOutboxWorkerLegalEntityScopeBackend,
} from '../../src/outbox/legal-entity-scope-fanout.ts';
import { OutboxWorkerTenantScope, OutboxWorkerTenantScopeLive } from '../../src/outbox/tenant-scope.ts';
import { makeTestDatabase } from '../support/database.ts';

const revision = 'a'.repeat(64);
const tenantId = '10000000-0000-4000-8000-000000000001';
const legalEntityId = '20000000-0000-4000-8000-000000000002';
const context = {
  attemptNumber: 1,
  claimId: 'claim-1',
  compositionRevision: revision,
  consumerModuleKey: 'worker.fixture',
  deliveryId: 'delivery-1',
  domainEventId: 'event-1',
  messageId: 'message-1',
  producerModuleKey: 'producer.fixture',
  tenantId,
  tenantSequenceNo: 1n,
  topic: 'producer.fixture.message-created',
  workerKey: 'worker.fixture.projector',
};

it.effect('rejects stale Worker owner transactions before exposing either owner scope', () =>
  Effect.gen(function* rejectStaleWorkerScopes() {
    for (const authority of [
      [],
      [{ phase: 'active', revision: 'b'.repeat(64), subscriptionsJson: [], unexpired: true }],
      [{ phase: 'active', revision, subscriptionsJson: [], unexpired: false }],
    ]) {
      const statements: string[] = [];
      const database = yield* makeTestDatabase((statement) => {
        statements.push(statement);
        if (statement.includes("current_setting('transaction_isolation')")) {
          return Effect.succeed([{ isolation: 'read committed' }]);
        }
        if (statement.includes('from "core"."application_composition_authority"')) {
          return Effect.succeed(authority);
        }
        return Effect.succeed(
          statement.includes('from "core"."legal_entities"') ? [{ legalEntityId, status: 'active', tenantId }] : [],
        );
      });
      let callbacks = 0;
      const owner = () =>
        Effect.sync(() => {
          callbacks += 1;
        });
      const services = yield* Layer.build(
        OutboxWorkerTenantScopeLive.pipe(Layer.provide(Layer.succeed(CoreDatabase, { executor: database }))),
      );
      const tenantFailure = yield* Context.get(services, OutboxWorkerTenantScope)
        .run(attestOutboxWorkerHandlerContext({ ...context, legalEntityScope: 'forbidden' }), owner)
        .pipe(Effect.flip);
      const legalEntityFailure = yield* makeOutboxWorkerLegalEntityScopeFanout(
        makePostgresOutboxWorkerLegalEntityScopeBackend({ executor: database }),
      )
        .forEachScope(attestOutboxWorkerHandlerContext({ ...context, legalEntityScope: 'required' }), owner)
        .pipe(Effect.flip);
      expect(Predicate.isTagged(tenantFailure, 'OutboxWorkerTenantScopeError')).toBe(true);
      expect(Predicate.isTagged(legalEntityFailure, 'OutboxWorkerLegalEntityScopeError')).toBe(true);
      expect(callbacks).toBe(0);
      expect(statements.filter((statement) => statement.includes('pg_advisory_xact_lock_shared'))).toHaveLength(2);
      expect(statements.some((statement) => statement.includes('set_config'))).toBe(false);
      expect(statements.filter((statement) => /rollback/iu.test(statement))).toHaveLength(2);
    }
  }),
);

it.effect('permits already approved Workers to finish owner effects while the release drains', () =>
  Effect.gen(function* finishDrainingWorkerScopes() {
    const statements: string[] = [];
    const database = yield* makeTestDatabase((statement) => {
      statements.push(statement);
      if (statement.includes("current_setting('transaction_isolation')")) {
        return Effect.succeed([{ isolation: 'read committed' }]);
      }
      if (statement.includes('from "core"."application_composition_authority"')) {
        return Effect.succeed([{ phase: 'draining', revision, subscriptionsJson: [], unexpired: true }]);
      }
      if (statement.includes('set_config')) {
        return Effect.succeed([
          {
            legal_entity_id: statement.includes("set_config('ontos.legal_entity_id', '', true)") ? '' : legalEntityId,
            tenant_id: tenantId,
          },
        ]);
      }
      if (statement.includes('from "core"."legal_entities"')) {
        return Effect.succeed([{ legalEntityId, status: 'active', tenantId }]);
      }
      return Effect.succeed(statement.includes('from "core"."tenants"') ? [{ status: 'active', tenantId }] : []);
    });
    let callbacks = 0;
    const owner = (scope: { readonly tenantId: string }) =>
      Effect.sync(() => {
        expect(scope.tenantId).toBe(tenantId);
        callbacks += 1;
      });
    const services = yield* Layer.build(
      OutboxWorkerTenantScopeLive.pipe(Layer.provide(Layer.succeed(CoreDatabase, { executor: database }))),
    );
    yield* Context.get(services, OutboxWorkerTenantScope).run(
      attestOutboxWorkerHandlerContext({ ...context, legalEntityScope: 'forbidden' }),
      owner,
    );
    yield* makeOutboxWorkerLegalEntityScopeFanout(
      makePostgresOutboxWorkerLegalEntityScopeBackend({ executor: database }),
    ).forEachScope(attestOutboxWorkerHandlerContext({ ...context, legalEntityScope: 'required' }), owner);
    expect(callbacks).toBe(2);
    expect(statements.filter((statement) => statement.includes('pg_advisory_xact_lock_shared'))).toHaveLength(2);
    expect(statements.filter((statement) => /commit/iu.test(statement))).toHaveLength(2);
  }),
);
