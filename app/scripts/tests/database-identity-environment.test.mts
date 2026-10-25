import { ConfigProvider, Console, Effect, Layer, Redacted } from 'effect';
import { expect, it, rs } from 'effect-rstest';

import { exportDatabaseIdentityEnvironment, readDatabaseIdentityEnvironment } from '../ops/database-identities.mts';
import { DATABASE_IDENTITY_SECRETS, migratorSecretReference } from '../ops/database-identity-secrets.mts';
import { STAGE_ZEROPS_PROJECT_ID } from '../ops/stage-operations.mts';
import { fakeFiles, fakeStage, fakeZeropsApi, mutatingCommands } from './stage-operations-fixture.mts';

const SHARED_CREDENTIAL = 'shared-fixture';
const RUNTIME_URL = `postgresql://ontos_runtime:${SHARED_CREDENTIAL}@db18.zerops:5432/ontos?sslmode=require&user=ontos_runtime&username=ontos_runtime&password=${SHARED_CREDENTIAL}`;
const ENVIRONMENT_FILE = '/runner/github-env';
const passwords = Object.fromEntries(
  DATABASE_IDENTITY_SECRETS.map(({ secretKey }) => [
    migratorSecretReference(secretKey),
    `${secretKey}-test-password:@/%`,
  ]),
);

const fixture = (values: Readonly<Record<string, string>> = passwords) => {
  const stage = fakeStage({
    projectValues: values,
    sensitiveKeys: Object.keys(values),
    services: [{ hostname: 'migrator', id: 'migrator-id', status: 'ACTIVE' }],
  });
  const zerops = fakeZeropsApi(stage);
  const files = fakeFiles();
  return {
    files,
    layer: Layer.mergeAll(stage.layer, zerops.layer, files.layer),
    stage,
    zerops,
  };
};

it.effect('reads existing sensitive migrator secrets into the exact dedicated identity URLs without mutations', () =>
  Effect.gen(function* readsDedicatedUrls() {
    const test = fixture();
    const values = yield* readDatabaseIdentityEnvironment(STAGE_ZEROPS_PROJECT_ID, Redacted.make(RUNTIME_URL)).pipe(
      Effect.provide(test.layer),
    );
    expect(values.map(({ key }) => key)).toEqual(DATABASE_IDENTITY_SECRETS.map(({ identity }) => identity.urlKey));
    for (const [index, entry] of values.entries()) {
      const identity = DATABASE_IDENTITY_SECRETS[index];
      expect(identity).toBeDefined();
      const url = new URL(Redacted.value(entry.value));
      expect(url.username).toBe(identity?.identity.role);
      expect(decodeURIComponent(url.password)).toBe(passwords[migratorSecretReference(identity?.secretKey ?? '')]);
      expect(url.host).toBe('db18.zerops:5432');
      expect(url.pathname).toBe('/ontos');
      expect(url.searchParams.get('sslmode')).toBe('require');
      expect(url.searchParams.has('user')).toBe(false);
      expect(url.searchParams.has('username')).toBe(false);
      expect(url.searchParams.has('password')).toBe(false);
    }
    expect(test.zerops.serviceSecrets).toHaveLength(0);
    expect(mutatingCommands(test.stage.commands)).toHaveLength(0);
  }),
);

it.effect.each(['', 'REDACTED'])(
  'refuses a missing or masked dedicated secret (%j), never the shared password',
  (value) =>
    Effect.gen(function* failsClosed() {
      const test = fixture({ ...passwords, migrator_PARTY_REGISTRY_DB_PASSWORD: value });
      const failure = yield* readDatabaseIdentityEnvironment(STAGE_ZEROPS_PROJECT_ID, Redacted.make(RUNTIME_URL)).pipe(
        Effect.provide(test.layer),
        Effect.flip,
      );
      expect(failure.message).toMatch(/no value for migrator_PARTY_REGISTRY_DB_PASSWORD|only read .* masked/u);
      expect(test.zerops.serviceSecrets).toHaveLength(0);
      expect(mutatingCommands(test.stage.commands)).toHaveLength(0);
    }),
);

it.effect('masks credentials before writing the private runner environment and never logs them otherwise', () =>
  Effect.gen(function* exportsPrivately() {
    const test = fixture();
    const messages: unknown[] = [];
    const consoleService = yield* Console.Console;
    yield* Effect.acquireUseRelease(
      Effect.sync(() =>
        rs.spyOn(consoleService, 'log').mockImplementation((...args) => {
          messages.push(...args);
        }),
      ),
      () =>
        exportDatabaseIdentityEnvironment(STAGE_ZEROPS_PROJECT_ID, ENVIRONMENT_FILE).pipe(
          Effect.provide(test.layer),
          Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ DATABASE_URL: RUNTIME_URL }))),
        ),
      (spy) => Effect.sync(() => spy.mockRestore()),
    );
    const written = test.files.writes.get(ENVIRONMENT_FILE) ?? '';
    expect(written.split('\n').filter(Boolean)).toHaveLength(3);
    for (const { identity } of DATABASE_IDENTITY_SECRETS) {
      expect(written).toContain(`${identity.urlKey}=postgresql://${identity.role}:`);
    }
    const visible = messages
      .map(String)
      .filter((line) => !line.startsWith('::add-mask::'))
      .join('\n');
    for (const password of Object.values(passwords)) {
      expect(visible).not.toContain(password);
    }
    expect(messages.map(String).filter((line) => line.startsWith('::add-mask::'))).toHaveLength(6);
    expect(mutatingCommands(test.stage.commands)).toHaveLength(0);
  }),
);
