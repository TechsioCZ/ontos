/// <reference types="node" />
import { loadDatabaseConnectionPair } from '@app/core-runtime';
import { PgClient } from '@effect/sql-pg';
import { Console, Effect, Exit, Layer, Redacted, Schema } from 'effect';
import { Reactivity } from 'effect/unstable/reactivity';

class OwnerVerificationError extends Schema.TaggedError<OwnerVerificationError>()('OwnerVerificationError', {
  reason: Schema.String,
}) {}
interface StateInfrastructure {
  readonly enabled: boolean;
  readonly forced: boolean;
  readonly no_external_fk: boolean;
  readonly optimistic_revision: boolean;
  readonly policies: number;
  readonly primary_key: boolean;
  readonly runtime_bypass: boolean;
  readonly runtime_select: boolean;
  readonly runtime_super: boolean;
  readonly runtime_update: boolean;
  readonly unique_redemption: boolean;
}
const main = Effect.scoped(
  Effect.gen(function* verifyOwnerDatabase() {
    const pair = yield* loadDatabaseConnectionPair();
    const client = yield* PgClient.makeClient({ url: Redacted.make(pair.runtime.connectionString) });
    const rows = yield* client.unsafe<StateInfrastructure>(`select
 c.relrowsecurity as enabled,c.relforcerowsecurity as forced,
 (select count(*)::int from pg_catalog.pg_policy where polrelid=c.oid) as policies,
 exists(select 1 from pg_catalog.pg_constraint where conrelid=c.oid and contype='p') as primary_key,
 exists(select 1 from pg_catalog.pg_constraint where conrelid=c.oid and contype='c' and pg_get_constraintdef(oid) like '%revision%') as optimistic_revision,
 not exists(select 1 from pg_catalog.pg_constraint f join pg_catalog.pg_class target on target.oid=f.confrelid join pg_catalog.pg_namespace n on n.oid=target.relnamespace where f.conrelid=c.oid and f.contype='f' and n.nspname <> 'siampark_agreements') as no_external_fk,
 has_table_privilege(current_user,c.oid,'select') as runtime_select,
 has_table_privilege(current_user,c.oid,'update') as runtime_update,
 (select rolbypassrls from pg_catalog.pg_roles where rolname=current_user) as runtime_bypass,
 (select rolsuper from pg_catalog.pg_roles where rolname=current_user) as runtime_super,
 exists(select 1 from pg_catalog.pg_constraint where conrelid='siampark_agreements.gateway_assertion_redemptions'::regclass and contype='u') as unique_redemption
 from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace where n.nspname='siampark_agreements' and c.relname='state'`);
    const [row] = rows;
    if (
      row === undefined ||
      !row.enabled ||
      !row.forced ||
      row.policies !== 4 ||
      !row.primary_key ||
      !row.optimistic_revision ||
      !row.no_external_fk ||
      !row.runtime_select ||
      !row.runtime_update ||
      row.runtime_bypass ||
      row.runtime_super ||
      !row.unique_redemption
    ) {
      return yield* new OwnerVerificationError({
        reason: 'Owner RLS, permissions or concurrency infrastructure is incomplete',
      });
    }
    const unscoped = yield* client.unsafe<{ count: number }>(
      'select count(*)::int as count from siampark_agreements.state',
    );
    if (unscoped[0]?.count !== 0) {
      return yield* new OwnerVerificationError({ reason: 'Unscoped runtime read was not refused by RLS' });
    }
    return yield* Console.log('siampark-agreements database verification passed');
  }),
);
const mainLive = Layer.effectDiscard(main).pipe(Layer.provide(Reactivity.layer));
const result = await Effect.runPromiseExit(
  Effect.scoped(Layer.build(mainLive)).pipe(
    Effect.tapCause((cause) =>
      Console.error(
        'Owner database verification failed',
        cause.reasons.map((reason) => reason._tag),
      ),
    ),
  ),
);
if (Exit.isFailure(result)) {
  process.exitCode = 1;
}
