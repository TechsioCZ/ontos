/// <reference types="node" />
import { loadDatabaseConnectionPair } from '@app/core-runtime';
import { NodeRuntime } from '@effect/platform-node';
import { PgClient } from '@effect/sql-pg';
import { Cause, Console, Effect, Layer, Match, Redacted, Schema } from 'effect';
import { Reactivity } from 'effect/unstable/reactivity';
import { WorkStateSchema } from '../shared/apis/records.ts';

class OwnerVerificationError extends Schema.TaggedError<OwnerVerificationError>()('OwnerVerificationError', {
  reason: Schema.String,
}) {}
const CatalogSchema = Schema.Struct({
  enabled: Schema.Boolean,
  forced: Schema.Boolean,
  no_external_fk: Schema.Boolean,
  optimistic_revision: Schema.Boolean,
  policies: Schema.Int,
  primary_key: Schema.Boolean,
  runtime_bypass: Schema.Boolean,
  runtime_create: Schema.Boolean,
  runtime_delete: Schema.Boolean,
  runtime_insert: Schema.Boolean,
  runtime_select: Schema.Boolean,
  runtime_super: Schema.Boolean,
  runtime_update: Schema.Boolean,
  runtime_usage: Schema.Boolean,
  unique_redemption: Schema.Boolean,
});
const CountSchema = Schema.Array(Schema.Struct({ count: Schema.Int }));
const SnapshotSchema = Schema.Array(
  Schema.Struct({ revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)), state: WorkStateSchema }),
);
const demoTenant = '70000000-0000-4000-8000-000000000020';
const demoCompany = '71000000-0000-4000-8000-000000000020';
const stateMatchesDemoScope = (state: typeof WorkStateSchema.Type) =>
  state.collection.ref.tenantId === demoTenant &&
  new Set(state.tasks.map((task) => task.ref.resourceId)).size === state.tasks.length &&
  state.tasks.every(
    (task) =>
      task.ref.tenantId === demoTenant &&
      task.collectionRef.tenantId === demoTenant &&
      task.collectionRef.resourceId === state.collection.ref.resourceId &&
      task.contextRefs.every((ref) => ref.tenantId === demoTenant) &&
      (task.ownerPrincipalRef === undefined || task.ownerPrincipalRef.tenantId === demoTenant),
  );
const catalogMatches = (row: typeof CatalogSchema.Type) =>
  row.enabled &&
  row.forced &&
  row.policies === 4 &&
  row.primary_key &&
  row.optimistic_revision &&
  row.no_external_fk &&
  row.runtime_select &&
  row.runtime_insert &&
  row.runtime_update &&
  row.runtime_delete &&
  row.runtime_usage &&
  !row.runtime_create &&
  !row.runtime_bypass &&
  !row.runtime_super &&
  row.unique_redemption;
const verification = Effect.scoped(
  Effect.gen(function* verifyOwnerDatabase() {
    const pair = yield* loadDatabaseConnectionPair();
    const client = yield* PgClient.makeClient({ url: Redacted.make(pair.runtime.connectionString) });
    const catalog = yield* client
      .unsafe(`select
    c.relrowsecurity as enabled, c.relforcerowsecurity as forced,
    (select count(*)::int from pg_catalog.pg_policy where polrelid=c.oid) as policies,
    exists(select 1 from pg_catalog.pg_constraint where conrelid=c.oid and contype='p' and pg_get_constraintdef(oid) like '%tenant_id, legal_entity_id%') as primary_key,
    exists(select 1 from pg_catalog.pg_constraint where conrelid=c.oid and contype='c' and pg_get_constraintdef(oid) like '%revision >= 0%') as optimistic_revision,
    not exists(select 1 from pg_catalog.pg_constraint f join pg_catalog.pg_class target on target.oid=f.confrelid join pg_catalog.pg_namespace n on n.oid=target.relnamespace where f.conrelid=c.oid and f.contype='f' and n.nspname <> 'siampark_work') as no_external_fk,
    has_schema_privilege(current_user,n.oid,'usage') as runtime_usage,
    has_schema_privilege(current_user,n.oid,'create') as runtime_create,
    has_table_privilege(current_user,c.oid,'select') as runtime_select,
    has_table_privilege(current_user,c.oid,'insert') as runtime_insert,
    has_table_privilege(current_user,c.oid,'update') as runtime_update,
    has_table_privilege(current_user,c.oid,'delete') as runtime_delete,
    (select rolbypassrls from pg_catalog.pg_roles where rolname=current_user) as runtime_bypass,
    (select rolsuper from pg_catalog.pg_roles where rolname=current_user) as runtime_super,
    exists(select 1 from pg_catalog.pg_constraint where conrelid='siampark_work.gateway_assertion_redemptions'::regclass and contype='p' and pg_get_constraintdef(oid) like '%issuer, audience, jti%') as unique_redemption
    from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace
    where n.nspname='siampark_work' and c.relname='work_states'`)
      .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(CatalogSchema))));
    if (catalog.length !== 1 || catalog[0] === undefined || !catalogMatches(catalog[0])) {
      return yield* new OwnerVerificationError({
        reason: 'RLS, runtime grants or concurrency infrastructure is incomplete',
      });
    }
    const countVisible = (tenantId: string, legalEntityId: string) =>
      client.withTransaction(
        Effect.gen(function* countScopedVisibility() {
          yield* client`select set_config('ontos.tenant_id', ${tenantId}, true), set_config('ontos.legal_entity_id', ${legalEntityId}, true)`;
          const rows =
            yield* client`select count(*)::int as count from siampark_work.work_states where tenant_id=${demoTenant}::uuid and legal_entity_id=${demoCompany}::uuid`.pipe(
              Effect.flatMap(Schema.decodeUnknownEffect(CountSchema)),
            );
          return rows[0]?.count;
        }),
      );
    const unscoped = yield* client
      .unsafe('select count(*)::int as count from siampark_work.work_states')
      .pipe(Effect.flatMap(Schema.decodeUnknownEffect(CountSchema)));
    if (unscoped[0]?.count !== 0) {
      return yield* new OwnerVerificationError({ reason: 'Unscoped runtime read exposed owner state' });
    }
    const denied = yield* Effect.all(
      [
        countVisible('', demoCompany),
        countVisible(demoTenant, ''),
        countVisible('70000000-0000-4000-8000-000000000021', demoCompany),
        countVisible(demoTenant, '71000000-0000-4000-8000-000000000021'),
      ],
      { concurrency: 1 },
    );
    if (denied.some((count) => count !== 0)) {
      return yield* new OwnerVerificationError({ reason: 'Missing or foreign scope exposed the fixed demo state' });
    }
    const snapshot = yield* client.withTransaction(
      Effect.gen(function* readScopedSnapshot() {
        yield* client`select set_config('ontos.tenant_id', ${demoTenant}, true), set_config('ontos.legal_entity_id', ${demoCompany}, true)`;
        return yield* client
          .unsafe('select revision,state from siampark_work.work_states')
          .pipe(
            Effect.flatMap((rows) =>
              Schema.decodeUnknownEffect(SnapshotSchema)(rows).pipe(
                Effect.mapError((cause) =>
                  Object.defineProperty(
                    new OwnerVerificationError({ reason: `Exact-scope aggregate validation failed: ${cause.message}` }),
                    'cause',
                    { enumerable: false, value: cause },
                  ),
                ),
              ),
            ),
          );
      }),
    );
    if (snapshot.length !== 1 || snapshot[0] === undefined || !stateMatchesDemoScope(snapshot[0].state)) {
      return yield* new OwnerVerificationError({ reason: 'Exact demo scope must expose one valid seeded aggregate' });
    }
    return yield* Effect.void;
  }),
);
const reportTypedFailure = (failure: Effect.Error<typeof verification>) =>
  Console.error(
    Match.value(failure).pipe(
      Match.tag('OwnerVerificationError', ({ reason }) => reason),
      Match.orElse(() => 'Owner catalog or fixture decoding failed; details withheld'),
    ),
  );
const main = verification.pipe(
  Effect.tapError(reportTypedFailure),
  Effect.tapCause((cause) =>
    Console.error('siampark-work database verification failed; details withheld', {
      defects: Cause.hasDies(cause),
      typedFailures: Cause.hasFails(cause),
    }),
  ),
  Effect.tap(() =>
    Console.log(
      'siampark-work database verification passed: catalog, nonce PK, runtime grants, exact demo visibility and four denied scopes',
    ),
  ),
);
const mainLive = Layer.effectDiscard(main).pipe(Layer.provide(Reactivity.layer));
NodeRuntime.runMain(Effect.scoped(Layer.build(mainLive)), { disableErrorReporting: true });
