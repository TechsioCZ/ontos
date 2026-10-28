import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { NodeServices } from '@effect/platform-node';
import { PgClient } from '@effect/sql-pg';
import { Config, Effect, FileSystem, Layer, Option, Redacted, Schema } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/process';
import { Reactivity } from 'effect/reactivity';
import { expect, it } from 'effect-rstest';

import { DATABASE_IDENTITIES } from '../../database/identity-enrollment.ts';
import {
  DatabasePreparationPlanSchema,
  hashDatabaseState,
  readDatabaseStateLines,
} from '../postgres/database-state-fingerprint.mts';
import { quoteIdentifier } from '../postgres/database-login-roles.mts';

const appDirectory = fileURLToPath(new URL('../../', import.meta.url));

const preparationProof = Effect.scoped(
  Effect.gen(function* fullPreparationProof() {
    yield* Config.schema(Schema.Literals(['owned-postgres18']), 'DATABASE_FINGERPRINT_TEST_SANDBOX');
    const base = new URL(Redacted.value(yield* Config.Redacted('DATABASE_FINGERPRINT_TEST_DATABASE_URL')));
    expect(['localhost', '127.0.0.1']).toContain(base.hostname);
    expect(base.pathname).toBe('/postgres');
    const root = yield* PgClient.makeClient({ url: Redacted.make(base.href) });
    const database = `fingerprint_${process.pid}`;
    yield* root.unsafe(`create database ${quoteIdentifier(database)}`);
    yield* Effect.addFinalizer(() =>
      root.unsafe(`drop database ${quoteIdentifier(database)} with (force)`).pipe(Effect.orDie),
    );
    base.pathname = `/${database}`;
    const password = randomUUID();
    const environment = new Map<string, string>(
      Object.entries({
        DATABASE_ADMIN_URL: base.href,
        DATABASE_LOGIN_ROLE_POLICY: 'reconcile',
        pnpm_config_verify_deps_before_run: 'false',
        RELEASE_FINGERPRINT_KEY: 'owned-fingerprint-test-key',
        ULTRAMODERN_DEPLOYMENT_ENVIRONMENT: 'development',
      }),
    );
    for (const identity of DATABASE_IDENTITIES) {
      const url = new URL(base);
      url.username = identity.role;
      url.password = password;
      environment.set(identity.urlKey, url.href);
    }
    const portal = new URL(base);
    portal.username = 'portal_fingerprint_runtime';
    portal.password = password;
    environment.set('COMMERCE_PORTAL_AUTH_DATABASE_ADMIN_URL', base.href);
    environment.set('COMMERCE_PORTAL_AUTH_DATABASE_URL', portal.href);
    const fs = yield* FileSystem.FileSystem;
    const temporaryRoot = yield* Config.String('OWNED_TEMP_DIR');
    const directory = yield* fs.makeTempDirectoryScoped({ directory: temporaryRoot });
    const recordFile = `${directory}/database-record.json`;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const run = (command: string, args: readonly string[], overrides: Record<string, string> = {}) =>
      spawner
        .exitCode(
          ChildProcess.make(command, args, {
            cwd: appDirectory,
            env: { ...Object.fromEntries(environment), ...overrides },
            extendEnv: true,
            stderr: 'inherit',
            stdout: 'inherit',
          }),
        )
        .pipe(Effect.tap((code) => Effect.sync(() => expect(code).toBe(0))));
    yield* run(process.execPath, ['scripts/postgres/bootstrap-runtime-role.mts'], {
      DATABASE_LOGIN_ROLE_POLICY: 'initialize-local',
    });
    yield* run('pnpm', ['db:migrate:prepared:internal']);
    const client = yield* PgClient.makeClient({ url: Redacted.make(base.href) });
    yield* client.unsafe(
      `insert into core.application_composition_authority
        (revision, phase, valid_until, subscriptions_json) values ($1, 'active', now() + interval '1 hour', '[]')`,
      ['1'.repeat(64)],
    );
    const first = yield* readDatabaseStateLines(client);
    yield* run('pnpm', ['db:migrate:prepared:internal']);
    const second = yield* readDatabaseStateLines(client);
    expect(new Set(second)).toEqual(new Set(first));
    expect(hashDatabaseState(second)).toBe(hashDatabaseState(first));
    const digest = 'a'.repeat(64);
    yield* run(process.execPath, [
      'scripts/postgres/database-state-fingerprint.mts',
      '--inputs-digest',
      digest,
      '--output',
      recordFile,
    ]);
    const plan = (inputs = digest, overrides: Record<string, string> = {}) =>
      spawner
        .string(
          ChildProcess.make(
            process.execPath,
            ['scripts/stage-demo-migrate.mts', '--plan', '--inputs-digest', inputs, '--database-record', recordFile],
            {
              cwd: appDirectory,
              env: { ...Object.fromEntries(environment), ...overrides },
              extendEnv: true,
              stderr: 'inherit',
            },
          ),
        )
        .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(DatabasePreparationPlanSchema))));
    expect((yield* plan()).light).toBe(true);
    expect((yield* plan('b'.repeat(64))).reason).toBe('inputs-changed');
    expect((yield* plan(digest, { RELEASE_FINGERPRINT_KEY: '' })).light).toBe(false);
    const wrongWorker = new URL(environment.get('PARTY_REGISTRY_WORKER_DATABASE_URL') ?? base.href);
    wrongWorker.password = randomUUID();
    expect((yield* plan(digest, { PARTY_REGISTRY_WORKER_DATABASE_URL: wrongWorker.href })).light).toBe(false);
    yield* client.unsafe('grant select on core.application_composition_authority to public');
    expect((yield* plan()).reason).toBe('state-changed');
    yield* client.unsafe('revoke select on core.application_composition_authority from public');
    expect((yield* plan()).light).toBe(true);
    // Data/authority changes and sequence counters are intentionally outside the catalog hash.
    yield* client.unsafe("update core.application_composition_authority set phase='migrated', updated_at=now()");
    expect(hashDatabaseState(yield* readDatabaseStateLines(client))).toBe(hashDatabaseState(first));
    expect((yield* plan()).reason).toBe('authority-not-active');
    yield* client.unsafe("update core.application_composition_authority set phase='active'");
    yield* client.unsafe(
      "update trust.gateway_audience_roles set role_name='ontos_runtime' where audience=(select audience from trust.gateway_audience_roles limit 1)",
    );
    expect(hashDatabaseState(yield* readDatabaseStateLines(client))).toBe(hashDatabaseState(first));
    yield* run(process.execPath, ['scripts/postgres/bootstrap-runtime-role.mts']);
    yield* run(process.execPath, ['scripts/verify-application-db-schema.mts', '--concurrency', '4']);
    expect((yield* plan()).light).toBe(true);
    yield* client.unsafe(
      "update drizzle.__drizzle_migrations_core set hash='unexpected-journal-hash' where id=(select min(id) from drizzle.__drizzle_migrations_core)",
    );
    expect((yield* plan()).reason).toBe('state-changed');
  }),
);
// This proof resets cluster-global login credentials. Never run it on the shared integration cluster.
it.layer(Layer.mergeAll(NodeServices.layer, Reactivity.layer), { excludeTestServices: true })((suite) => {
  suite.effect(
    'a full preparation is catalog-idempotent; journal, ACL, identity and input drift force full',
    (context) =>
      Effect.gen(function* requireOwnedCluster() {
        const sandbox = yield* Config.option(
          Config.schema(Schema.Literals(['owned-postgres18']), 'DATABASE_FINGERPRINT_TEST_SANDBOX'),
        );
        if (Option.isNone(sandbox)) {
          return yield* Effect.sync(() => context.skip());
        }
        return yield* preparationProof;
      }),
  );
});
