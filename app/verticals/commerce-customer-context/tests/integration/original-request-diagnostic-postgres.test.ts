import { NodeCrypto, NodeServices } from '@effect/platform-node';
import { PgClient } from '@effect/sql-pg';
import { Crypto, Effect, FileSystem, Layer, Redacted, Result, Schema, Stream } from 'effect';
import { Reactivity } from 'effect/reactivity';
import { ChildProcess } from 'effect/process';
import { expect, it } from 'effect-rstest';

import { collectToolingProcess } from '../../../../scripts/tests/tooling-process-fixture.mts';

class OriginalRequestFixtureError extends Schema.TaggedError<OriginalRequestFixtureError>()(
  'OriginalRequestFixtureError',
  { reason: Schema.String },
) {}

const fixtureFailure = (reason: string) => Effect.fail(new OriginalRequestFixtureError({ reason }));

const docker = (args: readonly string[], input?: string) =>
  collectToolingProcess(
    ChildProcess.make('docker', args, {
      stderr: 'pipe',
      stdin: input === undefined ? 'ignore' : Stream.make(new TextEncoder().encode(input)),
      stdout: 'pipe',
    }),
  ).pipe(Effect.scoped);

const tenant = '10000000-0000-4000-8000-000000000001';
const company = '10000000-0000-4000-8000-000000000002';
const creator = '10000000-0000-4000-8000-000000000003';
const attempt = '10000000-0000-4000-8000-000000000004';
const foreign = '20000000-0000-4000-8000-000000000001';
const intent = 'commerce.customer-context.portal-enrollment.retail_self_enrollment.local-original';
const digest = 'd'.repeat(64);

it.live('recovers only one exact scoped intent on PostgreSQL, without row or privilege changes', () =>
  Effect.gen(function* originalRequestPostgres() {
    // Own one fresh memory-backed container, with cleanup registered before startup.
    const { name: ownedContainer, url } = yield* Effect.gen(function* originalRequestFixture() {
      const crypto = yield* Crypto.Crypto;
      const name = `ontos-original-request-${yield* crypto.randomUUIDv4()}`;
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* cleanupFixture() {
          const removed = yield* docker(['rm', '-f', name]);
          if (removed.status !== 0 && !removed.stderr.includes('No such container')) {
            yield* fixtureFailure(`Owned PostgreSQL cleanup failed: ${removed.stderr}`);
          }
          const retained = yield* docker(['container', 'inspect', name]);
          if (retained.status === 0 || !retained.stderr.includes('No such')) {
            yield* fixtureFailure('Owned PostgreSQL container removal was not confirmed');
          }
        }).pipe(Effect.orDie),
      );
      const started = yield* docker([
        'run',
        '--detach',
        '--pull=never',
        '--name',
        name,
        '--memory=256m',
        '--tmpfs',
        '/var/lib/postgresql:rw,size=128m',
        '--publish',
        '127.0.0.1::5432',
        '--env',
        'POSTGRES_HOST_AUTH_METHOD=trust',
        '--env',
        'POSTGRES_USER=postgres',
        '--env',
        'POSTGRES_DB=postgres',
        // Match the digest-qualified image cached by docker-compose.yml; --pull=never needs that exact reference.
        'postgres:18.6-alpine@sha256:10a5c69a83035ab5239f5620d708520e8b28f5aa1f2b20143e6024532edadfb5',
      ]);
      if (started.status !== 0) {
        return yield* fixtureFailure(`Owned PostgreSQL startup failed: ${started.stderr}`);
      }
      yield* Effect.gen(function* waitForPostgres() {
        const ready = yield* docker([
          'exec',
          name,
          'pg_isready',
          '-h',
          '127.0.0.1',
          '-U',
          'postgres',
          '-d',
          'postgres',
        ]);
        if (ready.status !== 0) {
          yield* fixtureFailure('Owned PostgreSQL fixture is not ready');
        }
      }).pipe(Effect.retry({ times: 100 }));
      const published = yield* docker(['port', name, '5432/tcp']);
      const port = /^127\.0\.0\.1:(?<port>\d+)\s*$/u.exec(published.stdout)?.groups?.port;
      if (published.status !== 0 || port === undefined || Number(port) < 1 || Number(port) > 65_535) {
        return yield* fixtureFailure('Owned PostgreSQL loopback port is invalid');
      }
      const initialized = yield* docker(
        ['exec', '-i', name, 'psql', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'],
        `CREATE ROLE ontos_runtime LOGIN NOSUPERUSER NOBYPASSRLS;
         CREATE SCHEMA commerce_customer_context;
         GRANT USAGE ON SCHEMA commerce_customer_context TO ontos_runtime;`,
      );
      if (initialized.status !== 0) {
        return yield* fixtureFailure(`Owned PostgreSQL bootstrap failed: ${initialized.stderr}`);
      }
      return { name, url: `postgresql://postgres@127.0.0.1:${port}/postgres` };
    });
    const admin = yield* PgClient.makeClient({ url: Redacted.make(url) });
    const runtimeUrl = new URL(url);
    runtimeUrl.username = 'ontos_runtime';
    const runtime = yield* PgClient.make({ maxConnections: 1, url: Redacted.make(runtimeUrl.href) });
    const fs = yield* FileSystem.FileSystem;
    for (const migration of ['20260916133538_third_midnight', '20261103120000_original-enrollment-request-read']) {
      const source = yield* fs.readFileString(
        new URL(`../../drizzle/${migration}/migration.sql`, import.meta.url).pathname,
      );
      const applied = yield* collectToolingProcess(
        ChildProcess.make(
          'docker',
          ['exec', '-i', ownedContainer, 'psql', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'],
          {
            stderr: 'pipe',
            stdin: Stream.make(new TextEncoder().encode(source)),
            stdout: 'pipe',
          },
        ),
      );
      if (applied.status !== 0) {
        yield* Effect.die(`Owned migration fixture failed: ${applied.stderr}`);
      }
    }
    yield* admin`insert into commerce_customer_context.portal_enrollment_attempts
      (portal_enrollment_attempt_id, tenant_id, target_legal_entity_id, created_by_principal_id,
       journey, intent_key, intent_digest)
      values (${attempt}::uuid, ${tenant}::uuid, ${company}::uuid, ${creator}::uuid,
       'RETAIL_SELF_ENROLLMENT', ${intent}, ${digest})`;
    const before = yield* admin`select row_to_json(attempt)::text as retained
      from commerce_customer_context.portal_enrollment_attempts attempt`;
    const read = (
      inputTenant: string | null = tenant,
      inputCompany: string | null = company,
      inputCreator = creator,
      inputIntent = intent,
      inputDigest = digest,
    ) => runtime<{ portal_enrollment_attempt_id: string }>`
      select * from commerce_customer_context.read_original_portal_enrollment(
        ${inputTenant}::uuid, ${inputCompany}::uuid, ${inputCreator}::uuid, ${inputIntent}, ${inputDigest})`;
    const scoped = <A, E, R>(effect: Effect.Effect<A, E, R>, localTenant = tenant, localCompany = company) =>
      runtime.withTransaction(
        Effect.gen(function* readonlyScope() {
          yield* runtime`set transaction read only`;
          yield* runtime`select set_config('ontos.tenant_id', ${localTenant}, true),
          set_config('ontos.legal_entity_id', ${localCompany}, true)`;
          return yield* effect;
        }),
      );
    expect(yield* scoped(read())).toEqual([{ portal_enrollment_attempt_id: attempt }]);
    for (const invalid of [
      read(foreign),
      read(tenant, foreign),
      read(tenant, company, foreign),
      read(tenant, company, creator, 'another-intent'),
      read(tenant, company, creator, intent, 'e'.repeat(64)),
      read(null),
      read(tenant, null),
    ]) {
      expect(yield* scoped(invalid)).toEqual([]);
    }
    expect(yield* read()).toEqual([]);
    expect(yield* scoped(read(), foreign)).toEqual([]);
    expect(yield* scoped(read(), tenant, foreign)).toEqual([]);
    for (const local of [
      ['', company],
      [tenant, ''],
      ['', ''],
    ] as const) {
      expect(yield* scoped(read(), ...local)).toEqual([]);
    }
    expect(Result.isFailure(yield* scoped(read(), 'malformed', company).pipe(Effect.result))).toBe(true);
    expect(
      Result.isFailure(
        yield* scoped(runtime`select * from commerce_customer_context.portal_enrollment_attempts`).pipe(Effect.result),
      ),
    ).toBe(true);
    const after = yield* admin`select row_to_json(attempt)::text as retained
      from commerce_customer_context.portal_enrollment_attempts attempt`;
    expect(after).toEqual(before);
    const privilege = yield* admin<{ direct_select: boolean; exact_execute: boolean; stable: boolean }>`
      select has_table_privilege('ontos_runtime', 'commerce_customer_context.portal_enrollment_attempts', 'SELECT')
        as direct_select,
        has_function_privilege('ontos_runtime',
          'commerce_customer_context.read_original_portal_enrollment(uuid,uuid,uuid,text,text)', 'EXECUTE')
        as exact_execute,
        p.provolatile = 's' as stable
      from pg_proc p where p.oid =
        'commerce_customer_context.read_original_portal_enrollment(uuid,uuid,uuid,text,text)'::regprocedure`;
    expect(privilege).toEqual([{ direct_select: false, exact_execute: true, stable: true }]);
  }).pipe(Effect.provide(Layer.mergeAll(Reactivity.layer, NodeServices.layer, NodeCrypto.layer))),
);
