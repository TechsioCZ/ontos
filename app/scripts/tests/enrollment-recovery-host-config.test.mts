import { Array as Arr, Order, ConfigProvider, Effect, Layer, Redacted, Result } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  enrollmentRecoveryHostConfig,
  EnrollmentRecoveryHostConfigError,
} from '../ops/enrollment-recovery-host-config.mts';
import { OpsShell } from '../ops/ops-shell.mts';
import type { OpsCommand } from '../ops/ops-shell.mts';
import { ZeropsApiError } from '../zerops-public-api-error.mts';
import { ZeropsPublicApi } from '../zerops-public-api.mts';

const OWNER = 'commerce-customer-context';
const RUNTIME_KEY = 'COMMERCE_PORTAL_AUTH_DATABASE_URL';
const ADMIN_KEY = 'COMMERCE_PORTAL_AUTH_DATABASE_ADMIN_URL';
const SYNTHETIC_SECRET = 'synthetic-never-emit-credential-123456789';
const RUNTIME_URL = 'postgresql://portal_runtime:runtime-password@db18:5432/portal';
const ADMIN_URL = 'postgresql://portal_admin:admin-password@db18:5432/portal';
const OWNER_VALUES = {
  COMMERCE_CORE_IDENTITY_API_KEY: SYNTHETIC_SECRET,
  COMMERCE_CORE_IDENTITY_BASE_URL: 'https://shell.example/shell-super-app-api',
  COMMERCE_PORTAL_AUTH_SECRET: SYNTHETIC_SECRET,
  COMMERCE_PORTAL_AUTH_URL: 'https://commerce.example',
  ONTOS_COMMERCE_CUSTOMER_CONTEXT_GATEWAY_API_KEY: SYNTHETIC_SECRET,
  ONTOS_SHELL_GATEWAY_BASE_URL: 'https://shell.example',
};
const expectedValues = { ...OWNER_VALUES, [RUNTIME_KEY]: RUNTIME_URL };
const redactedMap = (values: Readonly<Record<string, string>>) =>
  new Map(Object.entries(values).map(([key, value]) => [key, Redacted.make(value)]));

const unused = () => Effect.die('Unexpected API method');
const NOT_COPIED = 'must-not-copy';
const DATABASE_ID = 'database-id';
const MIGRATOR_ID = 'migrator-id';
const reference = (key: string) => `\${${key}}`;
const TEMPLATE_RUNTIME = `postgresql://portal_runtime:runtime-password@${reference('db18_hostname')}:${reference('db18_port')}/${reference('db18_dbName')}`;
const TEMPLATE_ADMIN = `postgresql://${reference('db18_superUser')}:${reference('db18_superUserPassword')}@${reference('db18_hostname')}:${reference('db18_port')}/${reference('db18_dbName')}`;
const DATABASE_VALUES = {
  dbName: 'portal',
  hostname: 'db18',
  port: '5432',
  superUser: 'portal_admin',
  superUserPassword: SYNTHETIC_SECRET,
};

const fixture = (
  options: {
    readonly config?: {
      readonly ALL_RELEASE_SECRETS?: string | null;
      readonly ZEROPS_MIGRATOR_SERVICE_ID?: string;
      readonly ZEROPS_OUTBOX_WORKER_HOST_SERVICE_ID?: string;
      readonly ZEROPS_PROJECT_ID?: string;
    };
    readonly database?: Readonly<Record<string, string>>;
    readonly databaseName?: string;
    readonly host?: Readonly<Record<string, string>>;
    readonly hostName?: string;
    readonly migrator?: Readonly<Record<string, string>>;
    readonly migratorName?: string;
    readonly owner?: unknown;
    readonly rawJson?: string;
    readonly serviceListing?: string;
  } = {},
) => {
  const database = redactedMap(options.database ?? DATABASE_VALUES);
  const host = redactedMap(options.host ?? {});
  const migrator = redactedMap(options.migrator ?? { [ADMIN_KEY]: ADMIN_URL, [RUNTIME_KEY]: RUNTIME_URL });
  const writes: { readonly content: Redacted.Redacted; readonly key: string; readonly serviceId: string }[] = [];
  const reads: string[] = [];
  const commands: OpsCommand[] = [];
  let failRead = false;
  let failWrite = false;
  let discardWrite = false;
  let afterWrite: (() => void) | undefined;
  const serviceValues = new Map([
    ['host-id', host],
    [DATABASE_ID, database],
    [MIGRATOR_ID, migrator],
  ]);
  const serviceNames = new Map([
    ['host-id', options.hostName ?? 'outboxworkerhost'],
    [DATABASE_ID, options.databaseName ?? 'db18'],
    [MIGRATOR_ID, options.migratorName ?? 'migrator'],
  ]);
  const api = ZeropsPublicApi.of({
    createServiceSecret: (serviceId, key, content) =>
      Effect.suspend(() => {
        if (failWrite) {
          return Effect.fail(new ZeropsApiError({ cause: SYNTHETIC_SECRET, message: SYNTHETIC_SECRET }));
        }
        writes.push({ content: Redacted.make(content), key, serviceId });
        if (!discardWrite) {
          host.set(key, Redacted.make(content));
        }
        afterWrite?.();
        return Effect.void;
      }),
    deleteService: unused,
    enableSubdomainAccess: unused,
    findServiceStack: unused,
    findServiceStackIdentity: unused,
    projectEnvFile: unused,
    projectEnvs: unused,
    serviceSecrets: (id) =>
      Effect.suspend(() => {
        reads.push(id);
        return failRead
          ? Effect.fail(new ZeropsApiError({ cause: SYNTHETIC_SECRET, message: SYNTHETIC_SECRET }))
          : Effect.succeed(serviceValues.get(id) ?? new Map<string, Redacted.Redacted>());
      }),
    serviceStack: (id) =>
      Effect.succeed({
        name: serviceNames.get(id) ?? 'unknown',
        status: 'ACTIVE',
        subdomainAccess: false,
      }),
    stopService: unused,
    upsertProjectEnv: unused,
  });
  const layer = Layer.mergeAll(
    Layer.succeed(ZeropsPublicApi, api),
    Layer.succeed(OpsShell, {
      run: (command: OpsCommand) =>
        Effect.sync(() => {
          commands.push(command);
          return (
            options.serviceListing ??
            '│ host-id │ outboxworkerhost │ ACTIVE │\n│ migrator-id │ migrator │ ACTIVE │\n│ database-id │ db18 │ ACTIVE │'
          );
        }),
    }),
    ConfigProvider.layer(
      ConfigProvider.fromUnknown({
        ALL_RELEASE_SECRETS: options.rawJson ?? JSON.stringify({ [OWNER]: options.owner ?? OWNER_VALUES }),
        ZEROPS_MIGRATOR_SERVICE_ID: MIGRATOR_ID,
        ZEROPS_OUTBOX_WORKER_HOST_SERVICE_ID: 'host-id',
        ZEROPS_PROJECT_ID: 'project-id',
        ...options.config,
      }),
    ),
  );
  return {
    commands,
    host,
    layer,
    reads,
    setAfterWrite: (action: () => void) => {
      afterWrite = action;
    },
    setDiscardWrite: () => {
      discardWrite = true;
    },
    setFailRead: () => {
      failRead = true;
    },
    setFailWrite: () => {
      failWrite = true;
    },
    writes,
  };
};

const expectSafeFailure = <A,>(result: Result.Result<A, EnrollmentRecoveryHostConfigError>, reason: string) => {
  expect(Result.isFailure(result)).toBe(true);
  if (Result.isFailure(result)) {
    expect(result.failure).toBeInstanceOf(EnrollmentRecoveryHostConfigError);
    expect(result.failure.reason).toBe(reason);
    expect(JSON.stringify(result.failure)).not.toContain(SYNTHETIC_SECRET);
    expect(String(result.failure)).not.toContain(SYNTHETIC_SECRET);
    expect('cause' in result.failure).toBe(false);
  }
};

it.effect('CHECK plans missing host keys without writing or exporting secret values', () =>
  Effect.gen(function* checkMissingHostValues() {
    const state = fixture();
    const report = yield* enrollmentRecoveryHostConfig('check').pipe(Effect.provide(state.layer));
    expect(Arr.sort(report.missingKeys, Order.String)).toEqual(Arr.sort(Object.keys(expectedValues), Order.String));
    expect(report.createdKeys).toEqual([]);
    expect(state.writes).toEqual([]);
    expect(state.reads).toEqual([MIGRATOR_ID, 'database-id', 'host-id']);
    expect(state.commands).toEqual([{ args: ['service', 'list', '--project-id', 'project-id'], command: 'zcli' }]);
    expect(JSON.stringify(report)).not.toContain(SYNTHETIC_SECRET);
    expect(JSON.stringify(report)).not.toContain(RUNTIME_URL);
  }),
);

it.effect('APPLY copies exact canonical values to the host only, preserves unrelated keys, and converges', () =>
  Effect.gen(function* applyCanonicalConfiguration() {
    const state = fixture({
      host: { COMMERCE_PORTAL_AUTH_URL: OWNER_VALUES.COMMERCE_PORTAL_AUTH_URL, KEEP: 'existing' },
    });
    const first = yield* enrollmentRecoveryHostConfig('apply').pipe(Effect.provide(state.layer));
    expect(first.createdKeys).toHaveLength(6);
    expect(state.writes.every(({ serviceId }) => serviceId === 'host-id')).toBe(true);
    for (const [key, value] of Object.entries(expectedValues)) {
      expect(Redacted.value(state.host.get(key) ?? Redacted.make('missing'))).toBe(value);
    }
    expect(Redacted.value(state.host.get('KEEP') ?? Redacted.make('missing'))).toBe('existing');
    const again = yield* enrollmentRecoveryHostConfig('apply').pipe(Effect.provide(state.layer));
    expect(again.createdKeys).toEqual([]);
    expect(state.writes).toHaveLength(6);
    yield* enrollmentRecoveryHostConfig('verify').pipe(Effect.provide(state.layer));
  }),
);

it.effect('rejects every missing required canonical field, including when host already has it', () =>
  Effect.gen(function* requireCanonicalOwnerValues() {
    for (const key of Object.keys(OWNER_VALUES)) {
      const owner = Object.fromEntries(Object.entries(OWNER_VALUES).filter(([name]) => name !== key));
      const state = fixture({ host: expectedValues, owner });
      const result = yield* enrollmentRecoveryHostConfig('apply').pipe(Effect.provide(state.layer), Effect.result);
      expectSafeFailure(result, 'canonical-value-invalid');
      expect(state.writes).toEqual([]);
      expect(state.reads).toEqual([]);
    }
  }),
);

it.effect('rejects malformed, missing, wrong-type and masked owner sources without leaking decoder input', () =>
  Effect.gen(function* rejectUnusableOwnerRecords() {
    for (const rawJson of [
      SYNTHETIC_SECRET,
      '{}',
      JSON.stringify({ [OWNER]: null }),
      JSON.stringify({ [OWNER]: { ...OWNER_VALUES, COMMERCE_PORTAL_AUTH_SECRET: 5 } }),
    ]) {
      const state = fixture({ rawJson });
      expectSafeFailure(
        yield* enrollmentRecoveryHostConfig('check').pipe(Effect.provide(state.layer), Effect.result),
        'canonical-owner-invalid',
      );
      expect(state.writes).toEqual([]);
    }
    for (const value of ['', 'REDACTED', '[REDACTED]', '<redacted>', '*****', reference('OTHER_KEY'), 'short']) {
      const state = fixture({ owner: { ...OWNER_VALUES, COMMERCE_PORTAL_AUTH_SECRET: value } });
      expectSafeFailure(
        yield* enrollmentRecoveryHostConfig('check').pipe(Effect.provide(state.layer), Effect.result),
        'canonical-value-invalid',
      );
      expect(state.writes).toEqual([]);
    }
  }),
);

it.effect('ignores foreign owners, grants, deployment settings, composition and owner-supplied DB credentials', () =>
  Effect.gen(function* restrictCopiedConfiguration() {
    const owner = {
      ...OWNER_VALUES,
      [ADMIN_KEY]: NOT_COPIED,
      COMMERCE_PORTAL_AUTH_VERIFICATION_WORKLOAD_GRANTS: NOT_COPIED,
      ONTOS_ACTIVE_APPLICATION_COMPOSITION_READ_TOKEN: NOT_COPIED,
      ONTOS_COMMERCE_EXTERNAL_IDENTITY_DEPLOYMENT: NOT_COPIED,
      [RUNTIME_KEY]: NOT_COPIED,
    };
    const state = fixture({ rawJson: JSON.stringify({ foreign: { key: 123 }, [OWNER]: owner }) });
    yield* enrollmentRecoveryHostConfig('apply').pipe(Effect.provide(state.layer));
    expect(
      Arr.sort(
        state.writes.map(({ key }) => key),
        Order.String,
      ),
    ).toEqual(Arr.sort(Object.keys(expectedValues), Order.String));
    expect(Redacted.value(state.host.get(RUNTIME_KEY) ?? Redacted.make('missing'))).toBe(RUNTIME_URL);
  }),
);

it.effect('carries only explicitly present optional provider settings without injecting defaults', () =>
  Effect.gen(function* carryOptionalConfiguration() {
    const optional = {
      COMMERCE_PORTAL_AUTH_NODE_ENV: 'production',
      COMMERCE_PORTAL_AUTH_SECRETS: `2:${SYNTHETIC_SECRET}`,
      COMMERCE_PORTAL_AUTH_TRUSTED_ORIGINS: 'https://store.example',
      COMMERCE_PORTAL_AUTH_TRUSTED_PROXIES: '2001:db8::1',
      ONTOS_EMAIL_FROM: 'commerce@example.com',
      SMTP_HOST: 'mail.example',
    };
    const state = fixture({ owner: { ...OWNER_VALUES, ...optional } });
    const report = yield* enrollmentRecoveryHostConfig('apply').pipe(Effect.provide(state.layer));
    expect(Arr.sort(report.managedKeys, Order.String)).toEqual(
      Arr.sort([...Object.keys(expectedValues), ...Object.keys(optional)], Order.String),
    );
    for (const [key, value] of Object.entries(optional)) {
      expect(Redacted.value(state.host.get(key) ?? Redacted.make('missing'))).toBe(value);
    }
    expect(state.host.has('SMTP_PASSWORD')).toBe(false);
  }),
);

it.effect('validates exact service names and distinct safe IDs before reading secrets', () =>
  Effect.gen(function* validateServiceIdentities() {
    for (const options of [
      { hostName: 'other-worker' },
      { migratorName: 'other-migrator' },
      { databaseName: 'other-database' },
      { serviceListing: '│ unknown-db │ db19 │ ACTIVE │' },
      { serviceListing: '│ db-one │ db18 │ ACTIVE │\n│ db-two │ db18 │ ACTIVE │' },
      { config: { ZEROPS_MIGRATOR_SERVICE_ID: 'host-id' } },
      { config: { ZEROPS_OUTBOX_WORKER_HOST_SERVICE_ID: '../host-id' } },
    ]) {
      const state = fixture(options);
      expectSafeFailure(
        yield* enrollmentRecoveryHostConfig('apply').pipe(Effect.provide(state.layer), Effect.result),
        'service-identity-invalid',
      );
      expect(state.reads).toEqual([]);
      expect(state.writes).toEqual([]);
    }
  }),
);

it.effect('requires the distinct canonical portal DB pair and rejects identity overrides and alternate sources', () =>
  Effect.gen(function* validatePortalDatabaseIdentity() {
    const invalidPairs: Readonly<Record<string, string>>[] = [
      {},
      { [ADMIN_KEY]: ADMIN_URL },
      { [RUNTIME_KEY]: RUNTIME_URL },
      { [ADMIN_KEY]: ADMIN_URL, [RUNTIME_KEY]: ADMIN_URL },
      { [ADMIN_KEY]: ADMIN_URL, [RUNTIME_KEY]: RUNTIME_URL.replace(':5432/portal', ':5432/other') },
      { [ADMIN_KEY]: ADMIN_URL, [RUNTIME_KEY]: `${RUNTIME_URL}?user=portal_admin` },
      { [ADMIN_KEY]: ADMIN_URL, [RUNTIME_KEY]: 'https://example.com/portal' },
      { [ADMIN_KEY]: ADMIN_URL, [RUNTIME_KEY]: RUNTIME_URL.replace('portal_runtime', '%ZZ') },
    ];
    for (const migrator of invalidPairs) {
      const state = fixture({ migrator, owner: { ...OWNER_VALUES, [RUNTIME_KEY]: RUNTIME_URL } });
      expectSafeFailure(
        yield* enrollmentRecoveryHostConfig('apply').pipe(Effect.provide(state.layer), Effect.result),
        'portal-database-pair-invalid',
      );
      expect(state.writes).toEqual([]);
    }
  }),
);

it.effect('resolves the real migrator template shape through only the verified database service', () =>
  Effect.gen(function* resolveCanonicalDatabaseReferences() {
    const state = fixture({
      migrator: { [ADMIN_KEY]: TEMPLATE_ADMIN, [RUNTIME_KEY]: TEMPLATE_RUNTIME },
    });
    yield* enrollmentRecoveryHostConfig('apply').pipe(Effect.provide(state.layer));
    expect(Redacted.value(state.host.get(RUNTIME_KEY) ?? Redacted.make('missing'))).toBe(RUNTIME_URL);
    expect(state.host.has(ADMIN_KEY)).toBe(false);
    expect(state.writes.every(({ serviceId }) => serviceId === 'host-id')).toBe(true);
    yield* enrollmentRecoveryHostConfig('verify').pipe(Effect.provide(state.layer));
  }),
);

it.effect('fails unresolved, masked, unknown or administrative runtime references before writes', () =>
  Effect.gen(function* rejectUnusableDatabaseReferences() {
    const cases = [
      { database: {}, runtime: TEMPLATE_RUNTIME },
      { database: { ...DATABASE_VALUES, hostname: 'REDACTED' }, runtime: TEMPLATE_RUNTIME },
      { database: { ...DATABASE_VALUES, port: '0' }, runtime: TEMPLATE_RUNTIME },
      { database: { ...DATABASE_VALUES, port: '5432/path' }, runtime: TEMPLATE_RUNTIME },
      { database: { ...DATABASE_VALUES, superUserPassword: '*****' }, runtime: TEMPLATE_RUNTIME },
      { database: DATABASE_VALUES, runtime: TEMPLATE_RUNTIME.replace('db18_hostname', 'other_hostname') },
      { database: DATABASE_VALUES, runtime: TEMPLATE_RUNTIME.replace('portal_runtime', reference('db18_superUser')) },
      { database: DATABASE_VALUES, runtime: 'REDACTED' },
    ];
    for (const item of cases) {
      const state = fixture({
        database: item.database,
        migrator: { [ADMIN_KEY]: TEMPLATE_ADMIN, [RUNTIME_KEY]: item.runtime },
      });
      expectSafeFailure(
        yield* enrollmentRecoveryHostConfig('apply').pipe(Effect.provide(state.layer), Effect.result),
        'database-reference-unavailable',
      );
      expect(state.writes).toEqual([]);
    }
  }),
);

it.effect('a mismatch in the final managed key blocks all writes in every mode, never rotating', () =>
  Effect.gen(function* rejectExistingMismatchesBeforeWrites() {
    for (const mode of ['check', 'apply', 'verify'] as const) {
      const state = fixture({ host: { [RUNTIME_KEY]: ADMIN_URL } });
      expectSafeFailure(
        yield* enrollmentRecoveryHostConfig(mode).pipe(Effect.provide(state.layer), Effect.result),
        'existing-value-mismatch',
      );
      expect(state.writes).toEqual([]);
    }
  }),
);

it.effect('VERIFY fails missing values and accepts only exact complete configuration', () =>
  Effect.gen(function* verifyConfiguration() {
    const missing = fixture();
    expectSafeFailure(
      yield* enrollmentRecoveryHostConfig('verify').pipe(Effect.provide(missing.layer), Effect.result),
      'host-value-missing',
    );
    expect(missing.writes).toEqual([]);
    const complete = fixture({ host: expectedValues });
    const report = yield* enrollmentRecoveryHostConfig('verify').pipe(Effect.provide(complete.layer));
    expect(report.missingKeys).toEqual([]);
    expect(complete.writes).toEqual([]);
  }),
);

it.effect('detects missing write readback and a concurrent mismatch before any further create', () =>
  Effect.gen(function* verifyWriteReadback() {
    const discarded = fixture();
    discarded.setDiscardWrite();
    expectSafeFailure(
      yield* enrollmentRecoveryHostConfig('apply').pipe(Effect.provide(discarded.layer), Effect.result),
      'host-value-missing',
    );
    const changed = fixture();
    changed.setAfterWrite(() => {
      changed.host.set(RUNTIME_KEY, Redacted.make(ADMIN_URL));
    });
    expectSafeFailure(
      yield* enrollmentRecoveryHostConfig('apply').pipe(Effect.provide(changed.layer), Effect.result),
      'existing-value-mismatch',
    );
    expect(changed.writes).toHaveLength(1);
  }),
);

it.effect('sanitizes provider read/write failures and Config failures without retaining raw causes', () =>
  Effect.gen(function* sanitizeProtectedFailures() {
    for (const kind of ['read', 'write'] as const) {
      const state = fixture();
      if (kind === 'read') {
        state.setFailRead();
      } else {
        state.setFailWrite();
      }
      expectSafeFailure(
        yield* enrollmentRecoveryHostConfig('apply').pipe(Effect.provide(state.layer), Effect.result),
        'protected-api-unavailable',
      );
    }
    const state = fixture({ config: { ALL_RELEASE_SECRETS: null } });
    expectSafeFailure(
      yield* enrollmentRecoveryHostConfig('check').pipe(Effect.provide(state.layer), Effect.result),
      'configuration-unavailable',
    );
    expect(state.writes).toEqual([]);
  }),
);
