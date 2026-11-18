import {
  DatabaseConfig,
  GatewayAssertionRedemptionService,
  GatewayAssertionReplayError,
  GatewayAssertionRedemptionUnavailableError,
  loadDatabaseConnectionPair,
} from '@app/core-runtime';
import { makeIsolatedNativeDatabaseFixture } from '@app/core-runtime/testing/isolated-native-database';
import { GATEWAY_ASSERTION_CLOCK_SKEW_SECONDS } from '@app/shared-contracts';
import { NodeChildProcessSpawner, NodeCrypto, NodeServices } from '@effect/platform-node';
import { PgClient } from '@effect/sql-pg';
import { Context, DateTime, Effect, Layer, Redacted, Result, Schema, Stream } from 'effect';
import { ChildProcess } from 'effect/process';
import { Reactivity } from 'effect/reactivity';
import { expect, it } from 'effect-rstest';

import {
  GatewayAssertionRedemptionDatabaseLive,
  GatewayAssertionRedemptionLive,
} from '../../src/auth/gateway-assertion-redemption-runtime.ts';

class RedemptionNativeSetupFailed extends Schema.TaggedError<RedemptionNativeSetupFailed>()(
  'RedemptionNativeSetupFailed',
  { reason: Schema.String },
) {}

const fixture = Effect.fn('payment-term-catalog.RedemptionNative.fixture')(function* fixture() {
  const sourceConnections = yield* loadDatabaseConnectionPair();
  const isolated = yield* makeIsolatedNativeDatabaseFixture({
    mode: 'empty',
    purpose: 'stabilization-1257-approval-fresh-proof',
    sourceConnections,
  });
  const migrate = Effect.gen(function* migrateActualOwnerHistory() {
    const child = yield* ChildProcess.make(
      'mise',
      ['exec', '--', 'pnpm', '--filter', '@app/payment-term-catalog', 'db:migrate'],
      {
        cwd: new URL('../../../../', import.meta.url).pathname,
        env: {
          APP_ENV_PATH: '/dev/null',
          DATABASE_ADMIN_URL: isolated.connections.admin.connectionString,
          DATABASE_URL: isolated.connections.runtime.connectionString,
        },
        extendEnv: true,
        stderr: 'pipe',
        stdout: 'pipe',
      },
    );
    const [code] = yield* Effect.all([child.exitCode, Stream.runDrain(child.stdout), Stream.runDrain(child.stderr)], {
      concurrency: 3,
    });
    if (code !== 0) {
      return yield* new RedemptionNativeSetupFailed({ reason: 'The isolated owner migration failed' });
    }
    return yield* Effect.void;
  });
  yield* migrate;
  const admin = yield* PgClient.makeClient({ url: Redacted.make(isolated.connections.admin.connectionString) });
  const runtime = yield* PgClient.makeClient({ url: Redacted.make(isolated.connections.runtime.connectionString) });
  const redemption = Effect.gen(function* makeProductionRedemptionLayer() {
    const services = yield* Layer.build(
      GatewayAssertionRedemptionLive.pipe(
        Layer.provide(GatewayAssertionRedemptionDatabaseLive),
        Layer.provide(Layer.succeed(DatabaseConfig, isolated.connections.runtime)),
      ),
    );
    return Context.get(services, GatewayAssertionRedemptionService);
  });
  return { admin, migrate, redemption, runtime };
});
const services = NodeChildProcessSpawner.layer.pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(NodeCrypto.layer),
  Layer.provideMerge(Reactivity.layer),
);
const assertion = (jti: string, expiresAtEpochSeconds: number) => ({
  audience: 'payment-term-catalog',
  expiresAtEpochSeconds,
  issuer: 'https://order-finalization.fixture.invalid',
  jti,
});

// One migrated database carries every proof in one deterministic sequence: the fresh journal and
// empty identity table first, then durable replay, then expiry cleanup, and the destructive
// storage-absence proof last. A fixture() per proof paid `create database` plus an owner migrator
// process three times over for the same schema.
it.layer(services, { excludeTestServices: true })('Payment Term Catalog durable gateway redemption', (suite) => {
  suite.effect(
    '#1257 payment-term-catalog installs replay identity and exact pre-auth runtime grants through actual forward migrations, then rejects concurrent, cross-instance and expired redemptions and fails closed when durable storage is absent',
    () =>
      fixture().pipe(
        Effect.flatMap((test) =>
          Effect.gen(function* proveDurableRedemptionAuthority() {
            const identities = 'select jti::text from payment_term_catalog.gateway_assertion_redemptions order by jti';
            const replayJti = '11111111-1111-4111-8111-111111111111';
            const expiredJti = '22222222-2222-4222-8222-222222222222';
            const acceptedJti = '33333333-3333-4333-8333-333333333333';
            const absentStorageJti = '44444444-4444-4444-8444-444444444444';
            const [before] = yield* test.admin.unsafe<{ readonly count: number }>(
              'select count(*)::integer as count from drizzle.__drizzle_migrations_payment_term_catalog',
            );
            yield* test.migrate;
            const [after] = yield* test.admin.unsafe<{ readonly count: number }>(
              'select count(*)::integer as count from drizzle.__drizzle_migrations_payment_term_catalog',
            );
            expect(before?.count).toBeGreaterThan(0);
            expect(after).toEqual(before);
            const [authority] = yield* test.admin.unsafe(`
      select not c.relrowsecurity and not c.relforcerowsecurity as global_pre_auth,
        has_table_privilege('ontos_runtime',c.oid,'SELECT') as can_select,
        has_table_privilege('ontos_runtime',c.oid,'INSERT') as can_insert,
        has_table_privilege('ontos_runtime',c.oid,'DELETE') as can_delete,
        has_table_privilege('ontos_runtime',c.oid,'UPDATE') as can_update,
        has_table_privilege('ontos_runtime',c.oid,'TRUNCATE') as can_truncate,
        has_table_privilege('ontos_runtime',c.oid,'REFERENCES') as can_reference,
        has_table_privilege('ontos_runtime',c.oid,'TRIGGER') as can_trigger,
        not exists(select 1 from aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a where a.grantee=0) as no_public_acl,
        (select count(*)::integer from pg_constraint k where k.conrelid=c.oid and k.contype='u'
          and pg_get_constraintdef(k.oid)='UNIQUE (issuer, audience, jti)') as identity_count,
        (select count(*)::integer from pg_indexes where schemaname='payment_term_catalog'
          and tablename='gateway_assertion_redemptions' and indexdef like '% USING btree (expires_at)') as expiry_indexes
      from pg_class c where c.oid='payment_term_catalog.gateway_assertion_redemptions'::regclass`);
            expect(authority).toEqual({
              can_delete: true,
              can_insert: true,
              can_reference: false,
              can_select: true,
              can_trigger: false,
              can_truncate: false,
              can_update: false,
              expiry_indexes: 1,
              global_pre_auth: true,
              identity_count: 1,
              no_public_acl: true,
            });
            expect(
              yield* test.runtime.unsafe('select jti from payment_term_catalog.gateway_assertion_redemptions'),
            ).toEqual([]);

            // Durable atomic replay across concurrent callers and restarted instances, with
            // audience identities kept separate.
            const first = yield* test.redemption;
            const second = yield* test.redemption;
            const now = Math.floor(DateTime.toEpochMillis(yield* DateTime.now) / 1000);
            const input = assertion(replayJti, now + 300);
            const outcomes = yield* Effect.all(
              [first.consume(input).pipe(Effect.result), second.consume(input).pipe(Effect.result)],
              { concurrency: 2 },
            );
            expect(outcomes.filter(Result.isSuccess)).toHaveLength(1);
            const failures = outcomes.filter(Result.isFailure);
            expect(failures).toHaveLength(1);
            for (const failure of failures) {
              expect(Schema.is(GatewayAssertionReplayError)(failure.failure)).toBe(true);
            }
            const restarted = yield* test.redemption;
            const replay = yield* restarted.consume(input).pipe(Effect.result);
            expect(Result.isFailure(replay)).toBe(true);
            if (Result.isFailure(replay)) {
              expect(Schema.is(GatewayAssertionReplayError)(replay.failure)).toBe(true);
            }
            yield* restarted.consume({ ...input, audience: 'other-owned-audience' });
            const rows = yield* test.runtime.unsafe(
              'select audience from payment_term_catalog.gateway_assertion_redemptions order by audience',
            );
            expect(rows).toHaveLength(2);

            // Expired input is rejected, and its replay evidence stays until the owner's scheduled
            // cleanup; accepting the next redemption neither removes it nor touches the live ones above.
            const redemption = yield* test.redemption;
            const expired = assertion(expiredJti, now - GATEWAY_ASSERTION_CLOCK_SKEW_SECONDS - 1);
            yield* test.admin.unsafe(
              'insert into payment_term_catalog.gateway_assertion_redemptions(issuer,audience,jti,expires_at) values($1,$2,$3,$4)',
              [
                expired.issuer,
                expired.audience,
                expired.jti,
                DateTime.toDateUtc(DateTime.makeUnsafe(expired.expiresAtEpochSeconds * 1000)),
              ],
            );
            const rejected = yield* redemption.consume(expired).pipe(Effect.result);
            expect(Result.isFailure(rejected)).toBe(true);
            if (Result.isFailure(rejected)) {
              expect(Schema.is(GatewayAssertionReplayError)(rejected.failure)).toBe(true);
            }
            expect(yield* test.runtime.unsafe(identities)).toEqual([
              { jti: replayJti },
              { jti: replayJti },
              { jti: expiredJti },
            ]);
            yield* redemption.consume(assertion(acceptedJti, now + 300));
            expect(yield* test.runtime.unsafe(identities)).toEqual([
              { jti: replayJti },
              { jti: replayJti },
              { jti: expiredJti },
              { jti: acceptedJti },
            ]);
            yield* test.admin.unsafe('drop table payment_term_catalog.gateway_assertion_redemptions');
            const unavailable = yield* redemption.consume(assertion(absentStorageJti, now + 300)).pipe(Effect.result);
            expect(Result.isFailure(unavailable)).toBe(true);
            if (Result.isFailure(unavailable)) {
              expect(Schema.is(GatewayAssertionRedemptionUnavailableError)(unavailable.failure)).toBe(true);
            }
          }),
        ),
        Effect.scoped,
      ),
  );
});
