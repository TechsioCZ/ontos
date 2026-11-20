import { DatabaseConfig, findPostgresFailure, loadDatabaseConnectionPair } from '@app/core-runtime';
import { CoreDatabaseLive } from '@app/core-runtime/db/client';
import { NodeServices } from '@effect/platform-node';
import { PgClient } from '@effect/sql-pg';
import {
  Array as EffectArray,
  Deferred,
  Duration,
  Effect,
  Fiber,
  Layer,
  Option,
  Order,
  Redacted,
  Result,
  Schema,
} from 'effect';
import { Reactivity } from 'effect/reactivity';
import { expect, it } from 'effect-rstest';

import { SYMMY_JOB_KEY } from '../../src/ops/symmy-route-bindings.ts';
import type { SymmyRequiredBinding } from '../../src/ops/symmy-route-bindings.ts';
import { SymmyRouteEnrollmentRefused } from '../../src/ops/symmy-route-enrollment-refused.ts';
import { enrollSymmyRoute } from '../../src/ops/symmy-route-enrollment-store.ts';
import type { SymmyRouteEnrollmentRun } from '../../src/ops/symmy-route-enrollment-store.ts';
import {
  SymmyRouteEnrollmentRequestSchema,
  symmyRouteEnrollmentLockKey,
  symmyRouteInventoryOf,
} from '../../src/ops/symmy-route-enrollment.ts';
import type { SymmyEnrollmentRouteKey, SymmyRouteChange } from '../../src/ops/symmy-route-enrollment.ts';

const admitWorkload = 'integration.symmy-admit';
const importWorkload = 'commerce.catalog.symmy-product-import';
const catalogModule = 'commerce.catalog';
const digest = (seed: string) => seed.repeat(64).slice(0, 64);
const services = Layer.mergeAll(NodeServices.layer, Reactivity.layer);

const GateSchema = Schema.Tuple([
  Schema.Struct({ active: Schema.Boolean, epoch: Schema.String, revision: Schema.String }),
]);
const ActiveSchema = Schema.Tuple([Schema.Struct({ active: Schema.Boolean })]);
const RouteSchema = Schema.Array(Schema.Struct({ mapping_version: Schema.String, route_revision: Schema.String }));
const RecordSchema = Schema.Array(
  Schema.Struct({
    change: Schema.String,
    operator_ref: Schema.String,
    previous_revision: Schema.OptionFromNullOr(Schema.String),
    reason: Schema.String,
    route_revision: Schema.String,
  }),
);
const WaitingSchema = Schema.Tuple([Schema.Struct({ waiting: Schema.Number })]);

const bindings: readonly SymmyRequiredBinding[] = [
  { identity: 'integration', purpose: 'job admission', workloads: [admitWorkload] },
  { identity: 'integration', purpose: 'commerce.catalog.create-product@2', workloads: [importWorkload] },
  { identity: 'executor', purpose: 'commerce.catalog.create-product@2', workloads: [importWorkload] },
  { identity: 'executor', purpose: 'Symmy job execution', workloads: [SYMMY_JOB_KEY] },
];
const operator: SymmyRouteEnrollmentRun = {
  attribution: { operatorRef: 'operator:route-enrollment-test', reason: 'Enroll the products route for the import' },
  mode: 'apply',
};
const enroll: SymmyRouteChange = { kind: 'enroll' };
const refusals = <A, E, R>(attempt: Effect.Effect<A, E, R>) =>
  Effect.flip(attempt).pipe(
    Effect.map((failure) => (Schema.is(SymmyRouteEnrollmentRefused)(failure) ? failure.refusals : [])),
  );
/** The Postgres code a statement is refused with. */
const refusedWith = <A, E, R>(attempt: Effect.Effect<A, E, R>) =>
  Effect.flip(attempt).pipe(Effect.map((failure) => Option.getOrUndefined(findPostgresFailure(failure))?.code));
/** An enrollment outcome, or the refusal codes that ended it. */
const outcomeOf = <A extends { readonly outcome: string }, E>(result: Result.Result<A, E>) =>
  Result.match(result, {
    onFailure: (failure) =>
      Schema.is(SymmyRouteEnrollmentRefused)(failure)
        ? failure.refusals.map(({ code }) => code).join(',')
        : 'unavailable',
    onSuccess: ({ outcome }) => outcome,
  });

/** A fresh Tenant with two active companies, the Symmy API-key principal and the one system worker. */
const makeFixture = Effect.fn('SymmyRouteEnrollmentPostgres.fixture')(function* makeFixture() {
  const connections = yield* loadDatabaseConnectionPair({ envPath: '/dev/null' });
  const admin = yield* PgClient.make({ url: Redacted.make(connections.admin.connectionString) });
  const tenantId = crypto.randomUUID();
  const legalEntityId = crypto.randomUUID();
  const otherLegalEntityId = crypto.randomUUID();
  const integrationId = crypto.randomUUID();
  const systemId = crypto.randomUUID();
  const slug = `route-enrollment-${tenantId}`;
  yield* admin`insert into core.tenants(tenant_id,name,slug,status,default_locale) values(${tenantId},'Route enrollment fixture',${slug},'active','en')`;
  for (const [company, registration] of [
    [legalEntityId, 'ROUTE-ENROLLMENT'],
    [otherLegalEntityId, 'ROUTE-ENROLLMENT-OTHER'],
  ] as const) {
    yield* admin`insert into core.legal_entities(legal_entity_id,tenant_id,legal_name,registration_country,registration_number,status) values(${company},${tenantId},'Route enrollment company','CZ',${registration},'active')`;
  }
  yield* admin`insert into core.principals(principal_id,tenant_id,kind,status,display_name) values(${integrationId},${tenantId},'integration','active','Symmy API key')`;
  yield* admin`insert into core.principals(principal_id,tenant_id,kind,status,display_name) values(${systemId},${tenantId},'system','active','Symmy worker')`;
  for (const moduleKey of [catalogModule, 'integration.symmy']) {
    yield* admin`insert into core.tenant_module_states(tenant_id,module_key,state) values(${tenantId},${moduleKey},'active')`;
  }
  for (const [principalId, workloadKey] of [
    [integrationId, admitWorkload],
    [integrationId, importWorkload],
    [systemId, importWorkload],
    [systemId, SYMMY_JOB_KEY],
  ] as const) {
    yield* admin`insert into core.access_workload_bindings(binding_id,incarnation,tenant_id,principal_id,workload_key,status) values(${crypto.randomUUID()},${crypto.randomUUID()},${tenantId},${principalId},${workloadKey},'active')`;
  }
  // The append-only enrollment records of this Tenant stay; nothing references them.
  yield* Effect.addFinalizer(() =>
    Effect.all([
      admin`delete from symmy_integration.job_retention_tombstones where tenant_id=${tenantId}`,
      admin`delete from symmy_integration.job_effects where tenant_id=${tenantId}`,
      admin`delete from symmy_integration.import_jobs where tenant_id=${tenantId}`,
      admin`delete from symmy_integration.job_routes where tenant_id=${tenantId}`,
    ]).pipe(Effect.orDie),
  );
  const request = (
    routeKey: Extract<SymmyEnrollmentRouteKey, 'adminProducts' | 'productsBatch'>,
    changes: {
      readonly legalEntityId?: string;
      readonly mappingVersion?: string;
      readonly routeId: string;
      readonly routeRevision?: string;
      readonly sourceRouteId?: string;
    },
  ) => {
    const configuration = {
      items: [
        {
          effects: [
            {
              effectKey: 'product',
              operation:
                routeKey === 'productsBatch'
                  ? { entrypointKey: 'commerce.catalog.create-product', moduleId: catalogModule, schemaVersion: '2' }
                  : {
                      entrypointKey: 'commerce.catalog.api.catalog-source-product-page',
                      moduleId: catalogModule,
                      schemaVersion: '1',
                    },
            },
          ],
          itemKey: 'product',
          source: {
            entityKind: 'PRODUCT',
            issuerId: 'AKROS_SYMMY',
            sourceNamespace: 'AKROS',
            sourceRecordId: 'product',
          },
        },
      ],
    };
    if (changes.sourceRouteId !== undefined) {
      Object.assign(configuration, { sourceRouteId: changes.sourceRouteId });
    }
    const route = {
      configuration,
      legalEntityId: changes.legalEntityId ?? legalEntityId,
      mappingVersion: changes.mappingVersion ?? 'map-v1',
      principalId: integrationId,
      routeId: changes.routeId,
      routeKey,
      routeRevision: changes.routeRevision ?? 'route-v1',
      tenantId,
    };
    // Only the write route pins a lifecycle policy.
    if (routeKey === 'productsBatch') {
      Object.assign(route, { lifecyclePolicy: { policyId: 'akros-symmy-jobs', revision: 'r1' } });
    }
    return Schema.decodeUnknownSync(SymmyRouteEnrollmentRequestSchema)(route);
  };
  const run = (input: {
    readonly change?: SymmyRouteChange;
    readonly request: ReturnType<typeof request>;
    readonly required?: readonly SymmyRequiredBinding[];
    readonly run: SymmyRouteEnrollmentRun;
  }) =>
    Effect.gen(function* runEnrollment() {
      const found = symmyRouteInventoryOf(input.request.routeKey);
      const inventory = yield* Option.isOption(found) && Option.isSome(found)
        ? Effect.succeed(found.value)
        : Effect.die(`${input.request.routeKey} has an inventory`);
      return yield* enrollSymmyRoute({
        change: input.change ?? enroll,
        inventory,
        plan: { bindings: input.required ?? bindings, moduleKeys: [catalogModule, 'integration.symmy'] },
        request: input.request,
        run: input.run,
      });
    }).pipe(Effect.provide(CoreDatabaseLive.pipe(Layer.provide(Layer.succeed(DatabaseConfig, connections.admin)))));
  return { admin, connections, integrationId, legalEntityId, otherLegalEntityId, request, run, tenantId };
});

it.effect(
  'enrolls, replays, replaces from the current revision and deactivates a route, recording who did each and why',
  () =>
    Effect.gen(function* enrollAgainstSchema() {
      const { admin, connections, integrationId, legalEntityId, request, run, tenantId } = yield* makeFixture();
      const routeId = crypto.randomUUID();
      const gate =
        admin`select active, epoch::text as epoch, revision from core.source_execution_gates where tenant_id=${tenantId} and gate_id=${routeId}`.pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(GateSchema)),
          Effect.map(([row]) => row),
        );
      const routes =
        admin`select mapping_version, route_revision from symmy_integration.job_routes where tenant_id=${tenantId}`.pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(RouteSchema)),
        );
      const records =
        admin`select change, operator_ref, previous_revision, reason, route_revision from symmy_integration.route_enrollment_records where tenant_id=${tenantId} and route_id=${routeId} order by recorded_at, record_id`.pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(RecordSchema)),
        );
      const originalRouteActive = (jobId: string) =>
        admin`select symmy_integration.symmy_original_route_active(${tenantId}::uuid, ${jobId}::uuid) as active`.pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(ActiveSchema)),
          Effect.map(([row]) => row.active),
        );
      const v1 = request('productsBatch', { routeId });
      const v2 = request('productsBatch', { routeId, routeRevision: 'route-v2' });

      // A missing binding is named, and nothing is written.
      const unheld: SymmyRequiredBinding = {
        identity: 'executor',
        purpose: 'recovery',
        workloads: ['commerce.catalog.symmy-product-read'],
      };
      expect(
        (yield* refusals(run({ request: v1, required: [...bindings, unheld], run: operator }))).map(({ code }) => code),
      ).toEqual(['executor_binding_missing']);
      expect((yield* run({ request: v1, run: { mode: 'dry-run' } })).outcome).toBe('would_enroll');
      expect(yield* routes).toEqual([]);

      const enrolled = yield* run({ request: v1, run: operator });
      expect(enrolled.outcome).toBe('enrolled');
      expect(enrolled.executors).toEqual(
        expect.arrayContaining([{ principalId: expect.any(String), workloadKey: SYMMY_JOB_KEY }]),
      );
      expect(enrolled.runtimePrerequisites.map(({ configuration }) => configuration)).toEqual([
        'ONTOS_SYMMY_JOB_RETENTION_POLICIES',
      ]);
      const first = yield* gate;
      expect(first).toMatchObject({ active: true, revision: 'route-v1' });
      expect((yield* run({ request: v1, run: operator })).outcome).toBe('unchanged');
      expect((yield* run({ request: v1, run: { mode: 'verify' } })).outcome).toBe('verified');
      expect((yield* gate).epoch).toBe(first.epoch);

      const remapped = request('productsBatch', { mappingVersion: 'map-v2', routeId });
      expect((yield* refusals(run({ request: remapped, run: operator }))).map(({ code }) => code)).toEqual([
        'route_drift',
      ]);
      const replaceV1: SymmyRouteChange = { currentRevision: 'route-v1', kind: 'replace' };
      expect(
        (yield* refusals(run({ change: replaceV1, request: remapped, run: operator }))).map(({ code }) => code),
      ).toEqual(['revision_not_advanced']);

      // One job with planned work and one blocked job keep the route from being replaced.
      const job = (jobId: string, key: string) =>
        admin`insert into symmy_integration.import_jobs(job_id,tenant_id,route_id,route_key,principal_id,legal_entity_id,fixture_id,idempotency_digest,intent_digest,phase,mapping_version,route_revision,execution_plan)
          values(${jobId},${tenantId},${routeId},'productsBatch',${integrationId},${legalEntityId},'INTERNAL_C14',${digest(key)},${digest(key)},'admitted','map-v1','route-v1','{"items":[]}'::jsonb)`;
      const effect = (jobId: string, state: 'blocked' | 'planned', outcome: string | null) => {
        const effectId = crypto.randomUUID();
        const itemId = crypto.randomUUID();
        const pinned = JSON.stringify({ effectKey: 'product-create', itemId, ref: { effectId } });
        return admin`insert into symmy_integration.job_effects(effect_id,tenant_id,job_id,item_id,effect_key,effect,state,outcome,version)
          values(${effectId},${tenantId},${jobId},${itemId},'product-create',${pinned}::jsonb,${state},${outcome}::jsonb,0)`.pipe(
          Effect.as(effectId),
        );
      };
      const plannedJob = crypto.randomUUID();
      const blockedJob = crypto.randomUUID();
      yield* job(plannedJob, 'a');
      yield* job(blockedJob, 'b');
      const plannedEffect = yield* effect(plannedJob, 'planned', null);
      yield* effect(
        blockedJob,
        'blocked',
        JSON.stringify({ effectId: crypto.randomUUID(), owner: catalogModule, status: 'denied' }),
      );
      expect(yield* originalRouteActive(plannedJob)).toBe(true);
      const outstanding = yield* refusals(run({ change: replaceV1, request: v2, run: operator }));
      expect(outstanding.map(({ code }) => code)).toEqual(['outstanding_work', 'outstanding_work']);
      expect(outstanding[0]?.detail).toContain(`${plannedJob} (planned)`);
      expect(outstanding[0]?.detail).toContain(`${blockedJob} (blocked)`);
      expect(outstanding[1]?.detail).toContain('integration.symmy.execute-symmy-retention');
      const deactivateV1: SymmyRouteChange = { currentRevision: 'route-v1', kind: 'deactivate' };
      expect(
        (yield* refusals(run({ change: deactivateV1, request: v1, run: operator }))).map(({ code }) => code),
      ).toEqual(['outstanding_work', 'outstanding_work']);
      expect((yield* gate).epoch).toBe(first.epoch);

      // The planned effect settles and retention erases the blocked job: the replacement rotates the epoch.
      yield* admin`update symmy_integration.job_effects set state='settled', outcome=${JSON.stringify({ effectId: plannedEffect, owner: catalogModule, status: 'accepted_change' })}::jsonb where effect_id=${plannedEffect}`;
      yield* admin`insert into symmy_integration.job_retention_tombstones(tenant_id,job_id,policy_id,policy_revision,authority_receipt_ref,authority_revision,retained_effect_ids)
        values(${tenantId},${blockedJob},'akros-symmy-jobs','r1','retention-receipt','authority-1','[]'::jsonb)`;
      expect((yield* run({ change: replaceV1, request: v2, run: { mode: 'dry-run' } })).outcome).toBe('would_replace');
      expect((yield* run({ change: replaceV1, request: v2, run: operator })).outcome).toBe('replaced');
      const rotated = yield* gate;
      expect(rotated).toMatchObject({ active: true, revision: 'route-v2' });
      expect(rotated.epoch).not.toBe(first.epoch);
      expect(yield* routes).toEqual([{ mapping_version: 'map-v1', route_revision: 'route-v2' }]);
      expect(yield* originalRouteActive(plannedJob)).toBe(false);
      expect(yield* originalRouteActive(blockedJob)).toBe(false);

      // A retried replacement is unchanged; a stale one never reinstalls the older configuration.
      expect((yield* run({ change: replaceV1, request: v2, run: operator })).outcome).toBe('unchanged');
      const v3 = request('productsBatch', { mappingVersion: 'map-v3', routeId, routeRevision: 'route-v3' });
      expect((yield* refusals(run({ change: replaceV1, request: v3, run: operator }))).map(({ code }) => code)).toEqual(
        ['revision_not_current'],
      );
      expect(
        (yield* refusals(run({ change: deactivateV1, request: v2, run: operator }))).map(({ code }) => code),
      ).toEqual(['revision_not_current']);

      // A deactivation at the current revision closes the gate and keeps the revision.
      const deactivateV2: SymmyRouteChange = { currentRevision: 'route-v2', kind: 'deactivate' };
      expect((yield* run({ change: deactivateV2, request: v2, run: operator })).outcome).toBe('deactivated');
      expect(yield* gate).toMatchObject({ active: false, revision: 'route-v2' });
      expect((yield* run({ change: deactivateV2, request: v2, run: operator })).outcome).toBe('unchanged');

      const attributed = {
        operator_ref: 'operator:route-enrollment-test',
        reason: 'Enroll the products route for the import',
      };
      expect(yield* records).toEqual([
        { ...attributed, change: 'enroll', previous_revision: Option.none(), route_revision: 'route-v1' },
        { ...attributed, change: 'replace', previous_revision: Option.some('route-v1'), route_revision: 'route-v2' },
        { ...attributed, change: 'deactivate', previous_revision: Option.some('route-v2'), route_revision: 'route-v2' },
      ]);

      // The records are append-only even for the administrative role, and the runtime role can neither read nor write them.
      expect(
        yield* refusedWith(
          admin`update symmy_integration.route_enrollment_records set reason='rewritten' where tenant_id=${tenantId}`,
        ),
      ).toBe('42501');
      expect(
        yield* refusedWith(admin`delete from symmy_integration.route_enrollment_records where tenant_id=${tenantId}`),
      ).toBe('42501');
      expect((yield* records).map(({ change }) => change)).toEqual(['enroll', 'replace', 'deactivate']);
      const runtime = yield* PgClient.make({ url: Redacted.make(connections.runtime.connectionString) });
      expect(yield* refusedWith(runtime`select record_id from symmy_integration.route_enrollment_records`)).toBe(
        '42501',
      );
      expect(
        yield* refusedWith(
          runtime`insert into symmy_integration.route_enrollment_records(change,operator_ref,reason,route_id,route_key,route_revision,tenant_id)
            values('enroll','runtime','forged',${routeId},'productsBatch','route-v9',${tenantId})`,
        ),
      ).toBe('42501');
    }).pipe(Effect.scoped, Effect.provide(services)),
  30_000,
);

/**
 * Two apply transactions of one Tenant and principal wait on the enrollment lock a third connection holds, then run
 * one after the other: the second reads the route the first committed, whatever company each names.
 */
const raceOnTheEnrollmentLock = Effect.fn('SymmyRouteEnrollmentPostgres.race')(function* raceOnTheEnrollmentLock(
  fixture: Effect.Success<ReturnType<typeof makeFixture>>,
  requests: readonly [ReturnType<typeof fixture.request>, ReturnType<typeof fixture.request>],
  required: readonly SymmyRequiredBinding[],
) {
  const holder = yield* PgClient.make({
    maxConnections: 1,
    url: Redacted.make(fixture.connections.admin.connectionString),
  });
  const monitor = yield* PgClient.make({
    maxConnections: 1,
    url: Redacted.make(fixture.connections.admin.connectionString),
  });
  const held = yield* Deferred.make<number>();
  const release = yield* Deferred.make<boolean>();
  const holding = yield* holder
    .withTransaction(
      Effect.gen(function* holdEnrollmentLock() {
        const [backend] = yield* holder.unsafe<{ readonly pid: number }>('select pg_backend_pid() as pid');
        if (backend === undefined) {
          return yield* Effect.die('The lock holder identifies its backend');
        }
        yield* holder.unsafe('select pg_advisory_xact_lock(hashtextextended($1::text, 0))', [
          symmyRouteEnrollmentLockKey(requests[0]),
        ]);
        yield* Deferred.succeed(held, backend.pid);
        return yield* Deferred.await(release);
      }),
    )
    .pipe(Effect.forkScoped);
  const holderPid = yield* Deferred.await(held);
  const attempts = yield* Effect.forEach(
    requests,
    (request) => fixture.run({ request, required, run: operator }).pipe(Effect.result, Effect.forkScoped),
    { concurrency: 'unbounded' },
  );
  const waitingOnHolder = monitor`select count(*)::int as waiting from pg_catalog.pg_stat_activity
    where wait_event_type = 'Lock' and wait_event = 'advisory' and ${holderPid} = any(pg_catalog.pg_blocking_pids(pid))`.pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(WaitingSchema)),
    Effect.map(([{ waiting }]) => waiting),
  );
  let waiting = yield* waitingOnHolder;
  for (let poll = 0; poll < 100 && waiting < 2; poll += 1) {
    yield* Effect.sleep(Duration.millis(50));
    waiting = yield* waitingOnHolder;
  }
  expect(waiting).toBe(2);
  yield* Deferred.succeed(release, true);
  yield* Fiber.join(holding);
  return yield* Effect.all(attempts.map((attempt) => Fiber.join(attempt)));
});

it.live(
  'serializes two first enrollments of one principal and route kind in two companies, and refuses the second',
  () =>
    Effect.gen(function* raceAcrossCompanies() {
      const fixture = yield* makeFixture();
      const first = fixture.request('productsBatch', { routeId: crypto.randomUUID() });
      const second = fixture.request('productsBatch', {
        legalEntityId: fixture.otherLegalEntityId,
        routeId: crypto.randomUUID(),
      });
      const results = yield* raceOnTheEnrollmentLock(fixture, [first, second], bindings);
      expect(EffectArray.sort(results.map(outcomeOf), Order.String)).toEqual(['enrolled', 'route_selector_ambiguous']);
      const enrolled = yield* fixture.admin`select count(*)::int as waiting from symmy_integration.job_routes
        where tenant_id=${fixture.tenantId} and principal_id=${fixture.integrationId} and route_key='productsBatch'`.pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(WaitingSchema)),
      );
      expect(enrolled[0].waiting).toBe(1);
    }).pipe(Effect.scoped, Effect.provide(services)),
  30_000,
);

it.live(
  'serializes the first write and read routes of one source, and refuses the one naming another logical source',
  () =>
    Effect.gen(function* raceAcrossSourcePeers() {
      const fixture = yield* makeFixture();
      const writer = fixture.request('productsBatch', {
        routeId: crypto.randomUUID(),
        sourceRouteId: crypto.randomUUID(),
      });
      const reader = fixture.request('adminProducts', {
        routeId: crypto.randomUUID(),
        sourceRouteId: crypto.randomUUID(),
      });
      const routeContext: SymmyRequiredBinding = {
        identity: 'integration',
        purpose: 'route context',
        workloads: [admitWorkload],
      };
      const results = yield* raceOnTheEnrollmentLock(fixture, [writer, reader], [routeContext]);
      expect(EffectArray.sort(results.map(outcomeOf), Order.String)).toEqual([
        'enrolled',
        'source_identity_differs_from_counterpart',
      ]);
    }).pipe(Effect.scoped, Effect.provide(services)),
  30_000,
);
