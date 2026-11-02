import { sql } from 'drizzle-orm';
import { NodeChildProcessSpawner, NodeServices } from '@effect/platform-node';
import { Crypto, DateTime, Effect, Exit, Layer, Option, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { RetainedOwnerHistoryEnvelopeSchema } from '../../src/actions/retained-owner-history.ts';
import { makeCoreDatabase } from '../../src/db/client.ts';
import { actionInvocations, domainEvents, legalEntities, tenants } from '../../src/db/schema.ts';
import { findPostgresFailure } from '../../src/database/postgres-failure.ts';
import { makeIsolatedNativeDatabaseFixture } from '../../src/testing/isolated-native-database.ts';

const nativeServices = NodeChildProcessSpawner.layer.pipe(Layer.provideMerge(NodeServices.layer));
const owner = 'owner.fixture';
const profileType = 'owner.fixture.profile';
const entitlementType = 'owner.fixture.entitlement';
const fixture = Effect.gen(function* historyFixture() {
  const isolated = yield* makeIsolatedNativeDatabaseFixture({
    mode: 'empty',
    purpose: 'stabilization-1229-payment-entitlement',
  });
  yield* isolated.migrateCoreSchema();
  yield* isolated.migrateCoreSchema();
  const { executor: admin } = yield* makeCoreDatabase(isolated.connections.admin);
  const { executor: runtime } = yield* makeCoreDatabase(isolated.connections.runtime);
  const crypto = yield* Crypto.Crypto;
  const tenantId = yield* crypto.randomUUIDv4();
  const legalEntityId = yield* crypto.randomUUIDv4();
  const otherLegalEntityId = yield* crypto.randomUUIDv4();
  yield* admin.insert(tenants).values({
    defaultLocale: 'en',
    name: 'Retained Core history',
    slug: `history-${tenantId}`,
    status: 'active',
    tenantId,
  });
  yield* admin.insert(legalEntities).values(
    [legalEntityId, otherLegalEntityId].map((id) => ({
      legalEntityId: id,
      legalName: 'History legal entity',
      registrationCountry: 'CZ',
      registrationNumber: id,
      status: 'active',
      tenantId,
    })),
  );
  // Core-owned test wrapper models a reviewed owner definer: owner, selectors and Ref types
  // are static; runtime callers cannot choose an event predicate or access the Core function.
  yield* admin.execute(
    sql`create function core.retained_history_fixture_reader(p_tenant uuid,p_le uuid,p_id text,p_limit integer)
    returns jsonb language sql security definer set search_path=pg_catalog,core as $body$
    select core.read_committed_owner_change_history_v1(p_tenant,p_le,'owner.fixture',
      jsonb_build_object('tenantId',p_tenant::text,'moduleId','owner.fixture','resourceType','owner.fixture.profile','resourceId',p_id),
      '[{"eventType":"owner.fixture.changed.v1","actionKey":"owner.fixture.change","binding":{"kind":"subject"}},
        {"eventType":"owner.fixture.removed.v1","actionKey":"owner.fixture.remove","binding":{"kind":"payload_refs","aggregateRefKey":"profileRef","subjectRefKey":"entitlementRef","subjectResourceType":"owner.fixture.entitlement"}}]'::jsonb,
      p_limit)
    $body$`,
    'objects',
  );
  yield* admin.execute(
    sql`revoke all on function core.retained_history_fixture_reader(uuid,uuid,text,integer) from public`,
    'objects',
  );
  yield* admin.execute(
    sql`grant execute on function core.retained_history_fixture_reader(uuid,uuid,text,integer) to ${sql.identifier(isolated.connections.runtime.user)}`,
    'objects',
  );
  const seed = Effect.fn('RetainedHistoryTest.seedCommitted')(function* seed(
    resourceId: string,
    options: {
      readonly actionKey?: string;
      readonly invocationLegalEntityId?: string;
      readonly noInvocation?: boolean;
      readonly payloadJson?: typeof Schema.Json.Type;
      readonly producer?: string;
      readonly removal?: boolean;
      readonly status?: 'failed' | 'indeterminate' | 'running' | 'succeeded';
    } = {},
  ) {
    const removal = options.removal === true;
    const profileRef = { moduleId: owner, resourceId, resourceType: profileType, tenantId };
    const entitlementRef = { ...profileRef, resourceId: `${resourceId}-entitlement`, resourceType: entitlementType };
    let invocationId: string | null = null;
    if (options.noInvocation !== true) {
      const [invocation] = yield* admin
        .insert(actionInvocations)
        .values({
          actionKey: options.actionKey ?? (removal ? 'owner.fixture.remove' : 'owner.fixture.change'),
          completedAt: yield* DateTime.nowAsDate,
          legalEntityId: options.invocationLegalEntityId ?? legalEntityId,
          requestHash: 'retained-original-test',
          status: options.status ?? 'succeeded',
          tenantId,
        })
        .returning({ id: actionInvocations.actionInvocationId });
      invocationId = Option.getOrThrow(Option.fromNullishOr(invocation)).id;
    }
    const payloadJson =
      options.payloadJson ??
      (removal
        ? { entitlementRef, profileRef, revision: 3 }
        : {
            changes: [
              { kind: 'GRANT', sequence: 1 },
              { kind: 'END', sequence: 2 },
            ],
            profileRef,
            revision: 2,
          });
    const [event] = yield* admin
      .insert(domainEvents)
      .values({
        actionInvocationId: invocationId,
        eventType: removal ? 'owner.fixture.removed.v1' : 'owner.fixture.changed.v1',
        legalEntityId,
        payloadJson,
        producerModuleKey: options.producer ?? owner,
        subjectModuleKey: owner,
        subjectResourceId: removal ? entitlementRef.resourceId : resourceId,
        subjectResourceType: removal ? entitlementType : profileType,
        tenantId,
      })
      .returning({ id: domainEvents.domainEventId });
    return { eventId: Option.getOrThrow(Option.fromNullishOr(event)).id, payloadJson };
  });
  const read = Effect.fn('RetainedHistoryTest.ownerRead')(function* read(
    resourceId: string,
    options: {
      readonly installedLegalEntityId?: string;
      readonly installedTenantId?: string;
      readonly limit?: number;
      readonly noScope?: boolean;
    } = {},
  ) {
    return yield* runtime.transaction(
      Effect.fn(function* readScoped(transaction) {
        if (options.noScope !== true) {
          yield* transaction.execute(
            sql`select set_config('ontos.tenant_id',${options.installedTenantId ?? tenantId},true),set_config('ontos.legal_entity_id',${options.installedLegalEntityId ?? legalEntityId},true)`,
            'objects',
          );
        }
        const [row] = yield* transaction.execute<{ readonly payload: unknown }>(
          sql`select core.retained_history_fixture_reader(${tenantId}::uuid,${legalEntityId}::uuid,${resourceId},${options.limit ?? 256}) as payload`,
          'objects',
        );
        return yield* Schema.decodeUnknownEffect(RetainedOwnerHistoryEnvelopeSchema, { onExcessProperty: 'error' })(
          Option.getOrThrow(Option.fromNullishOr(row)).payload,
        );
      }),
    );
  });
  return { admin, legalEntityId, otherLegalEntityId, read, runtime, seed, tenantId };
});

it.layer(nativeServices, { excludeTestServices: true })('retained owner change history', (suite) => {
  suite.effect('reads committed original payloads through an owner definer and denies direct runtime access', () =>
    Effect.gen(function* originalCommittedHistory() {
      const f = yield* fixture;
      const first = yield* f.seed('profile-1');
      yield* f.seed('unrelated-profile');
      const last = yield* f.seed('profile-1', { removal: true });
      const result = yield* f.read('profile-1');
      expect(result.outcome).toBe('READ_COMPLETE');
      expect(result.events.map((event) => event.domainEventId)).toEqual([first.eventId, last.eventId]);
      expect(result.events.map((event) => event.payloadJson)).toEqual([first.payloadJson, last.payloadJson]);
      expect(
        BigInt(Option.getOrThrow(Option.fromNullishOr(result.events[1])).tenantSequenceNo) -
          BigInt(Option.getOrThrow(Option.fromNullishOr(result.events[0])).tenantSequenceNo),
      ).toBeGreaterThan(1n);
      const [routine] = yield* f.runtime.execute<{
        readonly execute: boolean;
        readonly fixed: boolean;
        readonly owner: boolean;
        readonly security: boolean;
      }>(
        sql`select has_function_privilege(current_user,p.oid,'EXECUTE') as execute,
      p.proconfig=array['search_path=pg_catalog, core']::text[] as fixed,p.prosecdef as security,
      (pg_has_role(current_user,p.proowner,'USAGE') or pg_has_role(current_user,p.proowner,'SET')) as owner
      from pg_proc p where p.oid=to_regprocedure('core.read_committed_owner_change_history_v1(uuid,uuid,text,jsonb,jsonb,integer)')`,
        'objects',
      );
      expect(routine).toEqual({ execute: false, fixed: true, owner: false, security: true });
      const denied = yield* f.runtime
        .execute(
          sql`select core.read_committed_owner_change_history_v1(${f.tenantId}::uuid,${f.legalEntityId}::uuid,'owner.fixture','{}'::jsonb,'[]'::jsonb,1)`,
          'objects',
        )
        .pipe(Effect.exit);
      expect(Exit.isFailure(denied)).toBe(true);
      if (Exit.isFailure(denied)) {
        expect(Option.getOrThrow(findPostgresFailure(denied.cause)).code).toBe('42501');
      }
    }),
  );
  suite.effect('makes overflow unusable and never treats missing or foreign installed scope as an empty history', () =>
    Effect.gen(function* historyBoundaries() {
      const f = yield* fixture;
      expect((yield* f.read('absent')).events).toEqual([]);
      yield* f.seed('overflow');
      yield* f.seed('overflow', { removal: true });
      const truncated = yield* f.read('overflow', { limit: 1 });
      expect(truncated.outcome).toBe('TRUNCATED');
      expect(truncated.events).toEqual([]);
      for (const options of [
        { noScope: true },
        { installedTenantId: f.otherLegalEntityId },
        { installedLegalEntityId: f.otherLegalEntityId },
      ]) {
        const failure = yield* f.read('overflow', options).pipe(Effect.exit);
        expect(Exit.isFailure(failure)).toBe(true);
        if (Exit.isFailure(failure)) {
          expect(Option.getOrThrow(findPostgresFailure(failure.cause)).code).toBe('42501');
        }
      }
      expect(Exit.isFailure(yield* f.read('overflow', { limit: 257 }).pipe(Effect.exit))).toBe(true);
    }),
  );
  suite.effect(
    'rejects unusable invocation/producer/action bindings rather than silently returning a partial chain',
    () =>
      Effect.gen(function* unusableRetainedBindings() {
        const f = yield* fixture;
        const invalid = [
          { status: 'running' },
          { status: 'failed' },
          { status: 'indeterminate' },
          { actionKey: 'owner.fixture.other' },
          { noInvocation: true },
          { producer: 'foreign.owner' },
          { invocationLegalEntityId: f.otherLegalEntityId },
        ] as const;
        for (let index = 0; index < invalid.length; index += 1) {
          const options = Option.getOrThrow(Option.fromNullishOr(invalid[index]));
          const profile = `invalid-${index}`;
          yield* f.seed(profile, options);
          const result = yield* f.read(profile);
          expect(result.outcome).toBe('UNUSABLE_BINDING');
          expect(result.events).toEqual([]);
        }
        const profileRef = {
          moduleId: owner,
          resourceId: 'invalid-subject',
          resourceType: profileType,
          tenantId: f.tenantId,
        };
        yield* f.seed('invalid-subject', {
          payloadJson: {
            entitlementRef: { ...profileRef, resourceId: 'different', resourceType: entitlementType },
            profileRef,
          },
          removal: true,
        });
        expect((yield* f.read('invalid-subject')).outcome).toBe('UNUSABLE_BINDING');
      }),
  );
});
