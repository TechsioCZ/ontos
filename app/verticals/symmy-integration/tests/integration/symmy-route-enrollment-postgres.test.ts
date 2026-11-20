import { DatabaseConfig, loadDatabaseConnectionPair } from '@app/core-runtime';
import { CoreDatabaseLive } from '@app/core-runtime/db/client';
import { NodeServices } from '@effect/platform-node';
import { PgClient } from '@effect/sql-pg';
import { Effect, Layer, Option, Redacted, Schema } from 'effect';
import { Reactivity } from 'effect/reactivity';
import { expect, it } from 'effect-rstest';

import { SYMMY_JOB_KEY } from '../../src/ops/symmy-route-bindings.ts';
import type { SymmyRequiredBinding } from '../../src/ops/symmy-route-bindings.ts';
import { SymmyRouteEnrollmentRefused } from '../../src/ops/symmy-route-enrollment-refused.ts';
import { enrollSymmyRoute } from '../../src/ops/symmy-route-enrollment-store.ts';
import type { SymmyRouteEnrollmentMode } from '../../src/ops/symmy-route-enrollment-store.ts';
import { SymmyRouteEnrollmentRequestSchema, symmyRouteInventoryOf } from '../../src/ops/symmy-route-enrollment.ts';

const admitWorkload = 'integration.symmy-admit';
const importWorkload = 'commerce.catalog.symmy-product-import';
const catalogModule = 'commerce.catalog';
const digest = (seed: string) => seed.repeat(64).slice(0, 64);

const GateSchema = Schema.Tuple([
  Schema.Struct({ active: Schema.Boolean, epoch: Schema.String, revision: Schema.String }),
]);
const ActiveSchema = Schema.Tuple([Schema.Struct({ active: Schema.Boolean })]);
const RouteSchema = Schema.Array(Schema.Struct({ mapping_version: Schema.String, route_revision: Schema.String }));

it.effect(
  'enrolls a route through the administrative transaction, replays it exactly, refuses drift and outstanding work, and rotates the epoch only after the work drained',
  () =>
    Effect.gen(function* enrollAgainstSchema() {
      const connections = yield* loadDatabaseConnectionPair({ envPath: '/dev/null' });
      const admin = yield* PgClient.make({ url: Redacted.make(connections.admin.connectionString) });
      const tenantId = crypto.randomUUID();
      const legalEntityId = crypto.randomUUID();
      const integrationId = crypto.randomUUID();
      const systemId = crypto.randomUUID();
      const routeId = crypto.randomUUID();
      const slug = `route-enrollment-${tenantId}`;
      yield* admin`insert into core.tenants(tenant_id,name,slug,status,default_locale) values(${tenantId},'Route enrollment fixture',${slug},'active','en')`;
      yield* admin`insert into core.legal_entities(legal_entity_id,tenant_id,legal_name,registration_country,registration_number,status) values(${legalEntityId},${tenantId},'Route enrollment company','CZ','ROUTE-ENROLLMENT','active')`;
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
      yield* Effect.addFinalizer(() =>
        Effect.all([
          admin`delete from symmy_integration.job_retention_tombstones where tenant_id=${tenantId}`,
          admin`delete from symmy_integration.job_effects where tenant_id=${tenantId}`,
          admin`delete from symmy_integration.import_jobs where tenant_id=${tenantId}`,
          admin`delete from symmy_integration.job_routes where tenant_id=${tenantId}`,
        ]).pipe(Effect.orDie),
      );

      const found = symmyRouteInventoryOf('productsBatch');
      const inventory = yield* Option.isOption(found) && Option.isSome(found)
        ? Effect.succeed(found.value)
        : Effect.die('the products route has an inventory');
      const bindings: readonly SymmyRequiredBinding[] = [
        { identity: 'integration', purpose: 'job admission', workloads: [admitWorkload] },
        { identity: 'integration', purpose: 'commerce.catalog.create-product@2', workloads: [importWorkload] },
        { identity: 'executor', purpose: 'commerce.catalog.create-product@2', workloads: [importWorkload] },
        { identity: 'executor', purpose: 'Symmy job execution', workloads: [SYMMY_JOB_KEY] },
      ];
      const request = (changes: { readonly mappingVersion?: string; readonly routeRevision?: string } = {}) =>
        Schema.decodeUnknownSync(SymmyRouteEnrollmentRequestSchema)({
          configuration: {
            items: [
              {
                effects: [
                  {
                    effectKey: 'product-create',
                    operation: {
                      entrypointKey: 'commerce.catalog.create-product',
                      moduleId: catalogModule,
                      schemaVersion: '2',
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
          },
          legalEntityId,
          lifecyclePolicy: { policyId: 'akros-symmy-jobs', revision: 'r1' },
          mappingVersion: changes.mappingVersion ?? 'map-v1',
          principalId: integrationId,
          routeId,
          routeKey: 'productsBatch',
          routeRevision: changes.routeRevision ?? 'route-v1',
          tenantId,
        });
      const enroll = (
        mode: SymmyRouteEnrollmentMode,
        enrollment = request(),
        replace = false,
        required: readonly SymmyRequiredBinding[] = bindings,
      ) =>
        enrollSymmyRoute({
          inventory,
          mode,
          plan: { bindings: required, moduleKeys: [catalogModule, 'integration.symmy'] },
          replace,
          request: enrollment,
        }).pipe(Effect.provide(CoreDatabaseLive.pipe(Layer.provide(Layer.succeed(DatabaseConfig, connections.admin)))));
      const refusals = (attempt: ReturnType<typeof enroll>) =>
        Effect.flip(attempt).pipe(
          Effect.map((failure) => (Schema.is(SymmyRouteEnrollmentRefused)(failure) ? failure.refusals : [])),
        );
      const gate =
        admin`select active, epoch::text as epoch, revision from core.source_execution_gates where tenant_id=${tenantId} and gate_id=${routeId}`.pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(GateSchema)),
          Effect.map(([row]) => row),
        );
      const routes =
        admin`select mapping_version, route_revision from symmy_integration.job_routes where tenant_id=${tenantId}`.pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(RouteSchema)),
        );
      const originalRouteActive = (jobId: string) =>
        admin`select symmy_integration.symmy_original_route_active(${tenantId}::uuid, ${jobId}::uuid) as active`.pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(ActiveSchema)),
          Effect.map(([row]) => row.active),
        );

      // A missing binding is named, and nothing is written.
      const unheld: SymmyRequiredBinding = {
        identity: 'executor',
        purpose: 'recovery',
        workloads: ['commerce.catalog.symmy-product-read'],
      };
      expect(
        (yield* refusals(enroll('apply', request(), false, [...bindings, unheld]))).map(({ code }) => code),
      ).toEqual(['executor_binding_missing']);
      expect((yield* enroll('dry-run')).outcome).toBe('would_enroll');
      expect(yield* routes).toEqual([]);

      const enrolled = yield* enroll('apply');
      expect(enrolled.outcome).toBe('enrolled');
      expect(enrolled.executors).toEqual(
        expect.arrayContaining([{ principalId: systemId, workloadKey: SYMMY_JOB_KEY }]),
      );
      const first = yield* gate;
      expect(first).toMatchObject({ active: true, revision: 'route-v1' });
      expect((yield* enroll('apply')).outcome).toBe('unchanged');
      expect((yield* enroll('verify')).outcome).toBe('verified');
      expect((yield* gate).epoch).toBe(first.epoch);

      expect((yield* refusals(enroll('apply', request({ mappingVersion: 'map-v2' })))).map(({ code }) => code)).toEqual(
        ['route_drift'],
      );
      expect(
        (yield* refusals(enroll('apply', request({ mappingVersion: 'map-v2' }), true))).map(({ code }) => code),
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
      const outstanding = yield* refusals(enroll('apply', request({ routeRevision: 'route-v2' }), true));
      expect(outstanding.map(({ code }) => code)).toEqual(['outstanding_work', 'outstanding_work']);
      expect(outstanding[0]?.detail).toContain(`${plannedJob} (planned)`);
      expect(outstanding[0]?.detail).toContain(`${blockedJob} (blocked)`);
      expect(outstanding[1]?.detail).toContain('integration.symmy.execute-symmy-retention');
      expect((yield* gate).epoch).toBe(first.epoch);

      // The planned effect settles and retention erases the blocked job: the replacement rotates the epoch.
      yield* admin`update symmy_integration.job_effects set state='settled', outcome=${JSON.stringify({ effectId: plannedEffect, owner: catalogModule, status: 'accepted_change' })}::jsonb where effect_id=${plannedEffect}`;
      yield* admin`insert into symmy_integration.job_retention_tombstones(tenant_id,job_id,policy_id,policy_revision,authority_receipt_ref,authority_revision,retained_effect_ids)
        values(${tenantId},${blockedJob},'akros-symmy-jobs','r1','retention-receipt','authority-1','[]'::jsonb)`;
      expect((yield* enroll('dry-run', request({ routeRevision: 'route-v2' }), true)).outcome).toBe('would_replace');
      expect((yield* enroll('apply', request({ routeRevision: 'route-v2' }), true)).outcome).toBe('replaced');
      const rotated = yield* gate;
      expect(rotated).toMatchObject({ active: true, revision: 'route-v2' });
      expect(rotated.epoch).not.toBe(first.epoch);
      expect(yield* routes).toEqual([{ mapping_version: 'map-v1', route_revision: 'route-v2' }]);
      expect(yield* originalRouteActive(plannedJob)).toBe(false);
      expect(yield* originalRouteActive(blockedJob)).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, Reactivity.layer))),
  30_000,
);
