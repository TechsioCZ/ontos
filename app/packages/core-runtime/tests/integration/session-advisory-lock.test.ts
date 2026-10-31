import { NodeCrypto } from '@effect/platform-node';

import { Crypto, Config, ConfigProvider, Deferred, Effect, Exit, Fiber, Predicate, Redacted } from 'effect';
import { expect, it } from 'effect-rstest';

import { withPostgresSessionAdvisoryLock } from '../../src/db/session-advisory-lock.ts';
import { makeTestPgClient } from '../support/database.ts';

// Connection-only proof: no schema, business data, or graph writes. Require injected configuration;
// unlike the application configuration loader, this must never load a workspace environment file.
const connection = Config.Redacted('DATABASE_URL').parse(ConfigProvider.fromEnv());

const fixture = Effect.gen(function* sessionLockFixture() {
  const crypto = yield* Crypto.Crypto;
  const url = yield* connection;
  const observer = yield* makeTestPgClient(Redacted.value(url));
  const lockKey = `session-lock-test:${yield* crypto.randomUUIDv4()}`;
  const lock = <Value, Failure, Requirements>(operation: Effect.Effect<Value, Failure, Requirements>) =>
    withPostgresSessionAdvisoryLock(url, lockKey, operation);
  const holders = observer.unsafe<{
    readonly pid: number;
    readonly state: string;
    readonly xactStart: Date | null;
  }>(
    `select a.pid, a.state, a.xact_start as "xactStart"
     from pg_locks l join pg_stat_activity a on a.pid = l.pid
     where l.locktype = 'advisory' and l.granted and l.objsubid = 1
       and ((l.classid::bigint << 32) | l.objid::bigint) = hashtextextended($1, 0)`,
    [lockKey],
  );
  // Native connection disposal sends Terminate; backend exit is asynchronous. Lock release
  // remains an immediate assertion below; only physical backend disappearance may converge.
  const awaitSessionClosed = Effect.fn('SessionLockTest.awaitSessionClosed')(function* awaitSessionClosed(
    pid: number | undefined,
  ) {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const sessions = yield* observer.unsafe('select pid from pg_stat_activity where pid = $1', [pid]);
      if (sessions.length === 0) {
        return;
      }
    }
    expect(yield* observer.unsafe('select pid from pg_stat_activity where pid = $1', [pid])).toHaveLength(0);
  });
  return { awaitSessionClosed, holders, lock, lockKey, observer, url };
});

it.layer(NodeCrypto.layer, { excludeTestServices: true })('session-advisory-lock', (suite) => {
  suite.effect(
    'serializes one key without an open transaction, permits independent scopes, and closes the session on success',
    () =>
      Effect.gen(function* sessionLockSuccess() {
        const { awaitSessionClosed, holders, lock, lockKey, url } = yield* fixture;
        const entered = yield* Deferred.make<null>();
        const release = yield* Deferred.make<null>();
        const first = yield* lock(
          Deferred.succeed(entered, null).pipe(Effect.andThen(Deferred.await(release)), Effect.as('completed')),
        ).pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        const [holder] = yield* holders;
        expect(holder).toBeDefined();
        expect(holder?.xactStart).toBeNull();
        expect(holder?.state).toBe('idle');
        let competingOperationRan = false;
        const busy = yield* lock(
          Effect.sync(() => {
            competingOperationRan = true;
          }),
        ).pipe(Effect.flip);
        expect(Predicate.isTagged(busy, 'SessionAdvisoryLockUnavailable')).toBe(true);
        expect(competingOperationRan).toBe(false);
        expect(yield* withPostgresSessionAdvisoryLock(url, `${lockKey}:other-company`, Effect.succeed(42))).toBe(42);
        yield* Deferred.succeed(release, null);
        expect(yield* Fiber.join(first)).toBe('completed');
        expect(yield* holders).toHaveLength(0);
        yield* awaitSessionClosed(holder?.pid);
        expect(yield* lock(Effect.succeed('retry'))).toBe('retry');
      }),
  );

  suite.effect('closes the physical session and releases its lock when the operation fails', () =>
    Effect.gen(function* sessionLockFailure() {
      const { holders, lock } = yield* fixture;
      const result = yield* lock(Effect.fail('operation-failed')).pipe(Effect.exit);
      expect(Exit.isFailure(result)).toBe(true);
      expect(yield* holders).toHaveLength(0);
      expect(yield* lock(Effect.succeed('retry'))).toBe('retry');
    }),
  );

  suite.effect('closes the physical session and releases its lock when the operation is interrupted', () =>
    Effect.gen(function* sessionLockInterruption() {
      const { awaitSessionClosed, holders, lock } = yield* fixture;
      const entered = yield* Deferred.make<null>();
      const operation = yield* lock(Deferred.succeed(entered, null).pipe(Effect.andThen(Effect.never))).pipe(
        Effect.forkChild,
      );
      yield* Deferred.await(entered);
      const [holder] = yield* holders;
      expect(holder).toBeDefined();
      yield* Fiber.interrupt(operation);
      expect(yield* holders).toHaveLength(0);
      yield* awaitSessionClosed(holder?.pid);
      expect(yield* lock(Effect.succeed('retry'))).toBe('retry');
    }),
  );
});
