/// <reference types="node" />
import { loadDatabaseConnectionPair } from '@app/core-runtime';
import { NodeRuntime, NodeServices } from '@effect/platform-node';
import { PgClient } from '@effect/sql-pg';
import { and, eq } from 'drizzle-orm';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import { Cause, Console, Effect, Layer, Match, Redacted, Schema } from 'effect';
import { Command, Flag } from 'effect/cli';
import { Reactivity } from 'effect/reactivity';
import { SalesInsightsStateSchema } from '../shared/apis/records.ts';
import { salesInsightsRelations, salesInsightsStates } from '../src/database/schema.ts';

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
const SnapshotSchema = Schema.Array(
  Schema.Struct({ revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)), state: SalesInsightsStateSchema }),
);
const demoTenant = '70000000-0000-4000-8000-000000000020';
const demoCompany = '71000000-0000-4000-8000-000000000020';
const stateMatchesDemoScope = (state: typeof SalesInsightsStateSchema.Type) =>
  state.collection.ref.tenantId === demoTenant &&
  new Set(state.metrics.map((metric) => metric.ref.resourceId)).size === state.metrics.length &&
  state.metrics.every(
    (metric) =>
      metric.ref.tenantId === demoTenant &&
      metric.collectionRef.tenantId === demoTenant &&
      metric.collectionRef.resourceId === state.collection.ref.resourceId &&
      metric.contextRefs.every((ref) => ref.tenantId === demoTenant) &&
      (metric.ownerPrincipalRef === undefined || metric.ownerPrincipalRef.tenantId === demoTenant),
  );
export const catalogMatches = (row: typeof CatalogSchema.Type) =>
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
type SnapshotRow = Pick<typeof salesInsightsStates.$inferSelect, 'revision' | 'state'>;
// Migration readiness allows no aggregate; seeded acceptance explicitly requires one.
export const verifySnapshot = Effect.fn('verifySnapshot')(function* verifySnapshot(
  rows: readonly SnapshotRow[],
  requireSeed: boolean,
) {
  const snapshot = yield* Schema.decodeUnknownEffect(SnapshotSchema)(rows);
  if (
    snapshot.length > 1 ||
    (requireSeed && snapshot.length !== 1) ||
    snapshot.some((row) => !stateMatchesDemoScope(row.state))
  ) {
    return yield* new OwnerVerificationError({
      reason: 'Exact scope must contain at most one valid aggregate; --require-seed requires one',
    });
  }
  return yield* Effect.void;
});
const runtimePgLive = PgClient.layerFrom(
  Effect.gen(function* runtimeConnection() {
    const pair = yield* loadDatabaseConnectionPair();
    return yield* PgClient.makeClient({ url: Redacted.make(pair.runtime.connectionString) });
  }),
).pipe(Layer.provide(Reactivity.layer));
const verification = (requireSeed: boolean) =>
  Effect.scoped(
    Effect.gen(function* verifyOwnerDatabase() {
      const client = yield* PgClient.PgClient;
      const db = yield* makeWithDefaults({ relations: salesInsightsRelations });
      // System catalogs have no owner-local Drizzle table; business reads below use typed references.
      const catalog = yield* client
        .unsafe(`select
    c.relrowsecurity as enabled, c.relforcerowsecurity as forced,
    (select count(*)::int from pg_catalog.pg_policy where polrelid=c.oid) as policies,
    exists(select 1 from pg_catalog.pg_constraint where conrelid=c.oid and contype='p' and pg_get_constraintdef(oid) like '%tenant_id, legal_entity_id%') as primary_key,
    exists(select 1 from pg_catalog.pg_constraint where conrelid=c.oid and contype='c' and pg_get_constraintdef(oid) like '%revision >= 0%') as optimistic_revision,
    not exists(select 1 from pg_catalog.pg_constraint f join pg_catalog.pg_class target on target.oid=f.confrelid join pg_catalog.pg_namespace n on n.oid=target.relnamespace where f.conrelid=c.oid and f.contype='f' and n.nspname <> 'demo_sales_insights') as no_external_fk,
    has_schema_privilege(current_user,n.oid,'usage') as runtime_usage,
    has_schema_privilege(current_user,n.oid,'create') as runtime_create,
    has_table_privilege(current_user,c.oid,'select') as runtime_select,
    has_table_privilege(current_user,c.oid,'insert') as runtime_insert,
    has_table_privilege(current_user,c.oid,'update') as runtime_update,
    has_table_privilege(current_user,c.oid,'delete') as runtime_delete,
    (select rolbypassrls from pg_catalog.pg_roles where rolname=current_user) as runtime_bypass,
    (select rolsuper from pg_catalog.pg_roles where rolname=current_user) as runtime_super,
    exists(select 1 from pg_catalog.pg_constraint where conrelid='demo_sales_insights.gateway_assertion_redemptions'::regclass and contype='p' and pg_get_constraintdef(oid) like '%issuer, audience, jti%') as unique_redemption
    from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace
    where n.nspname='demo_sales_insights' and c.relname='sales_insights_states'`)
        .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(CatalogSchema))));
      if (catalog.length !== 1 || catalog[0] === undefined || !catalogMatches(catalog[0])) {
        return yield* new OwnerVerificationError({
          reason:
            catalog[0] !== undefined && !catalog[0].forced
              ? 'Owner state table is missing FORCE ROW LEVEL SECURITY'
              : 'RLS, runtime grants or concurrency infrastructure is incomplete',
        });
      }
      const countVisible = (tenantId: string, legalEntityId: string) =>
        client.withTransaction(
          Effect.gen(function* countScopedVisibility() {
            yield* client`select set_config('ontos.tenant_id', ${tenantId}, true), set_config('ontos.legal_entity_id', ${legalEntityId}, true)`;
            const rows = yield* db
              .select({ tenantId: salesInsightsStates.tenantId })
              .from(salesInsightsStates)
              .where(
                and(eq(salesInsightsStates.tenantId, demoTenant), eq(salesInsightsStates.legalEntityId, demoCompany)),
              )
              .limit(1);
            return rows.length;
          }),
        );
      const unscoped = yield* db.select().from(salesInsightsStates).limit(1);
      if (unscoped.length !== 0) {
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
          return yield* db
            .select({ revision: salesInsightsStates.revision, state: salesInsightsStates.state })
            .from(salesInsightsStates);
        }),
      );
      yield* verifySnapshot(snapshot, requireSeed);
      return yield* Effect.void;
    }),
  );
const reportTypedFailure = (failure: Effect.Error<ReturnType<typeof verification>>) =>
  Console.error(
    Match.value(failure).pipe(
      Match.tag('OwnerVerificationError', ({ reason }) => reason),
      Match.orElse(() => 'Owner catalog or fixture decoding failed; details withheld'),
    ),
  );
const main = (requireSeed: boolean) =>
  verification(requireSeed).pipe(
    Effect.tapError(reportTypedFailure),
    Effect.tapCause((cause) =>
      Console.error('sales-insights database verification failed; details withheld', {
        defects: Cause.hasDies(cause),
        typedFailures: Cause.hasFails(cause),
      }),
    ),
    Effect.tap(() =>
      Console.log(
        `sales-insights database verification passed: catalog, nonce PK, runtime grants, existing scoped state and four denied scopes (${requireSeed ? 'seed required' : 'migration readiness'})`,
      ),
    ),
  );
const cli = Command.make(
  'verify-db-schema',
  {
    requireSeed: Flag.Boolean('require-seed').pipe(Flag.withDefault(false)),
  },
  ({ requireSeed }) => main(requireSeed),
);
const mainLive = Layer.effectDiscard(Command.run(cli, { version: '1.0.0' })).pipe(
  Layer.provide(runtimePgLive),
  Layer.provide(NodeServices.layer),
);
if (import.meta.main) {
  NodeRuntime.runMain(Effect.scoped(Layer.build(mainLive)), { disableErrorReporting: true });
}
