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
const RETIRED_KEY = 'COMMERCE_PORTAL_AUTH_DATABASE_URL';
const ADMIN_KEY = 'COMMERCE_PORTAL_AUTH_DATABASE_ADMIN_URL';
const SYNTHETIC_SECRET = 'synthetic-never-emit-credential-123456789';
const RETIRED_URL = 'postgresql://commerce_auth_runtime:runtime-password@db18:5432/portal';
const OWNER_VALUES = {
  COMMERCE_CORE_IDENTITY_API_KEY: SYNTHETIC_SECRET,
  COMMERCE_CORE_IDENTITY_BASE_URL: 'https://shell.example/shell-super-app-api',
  COMMERCE_PORTAL_AUTH_SECRET: SYNTHETIC_SECRET,
  COMMERCE_PORTAL_AUTH_URL: 'https://commerce.example',
  ONTOS_COMMERCE_CUSTOMER_CONTEXT_GATEWAY_API_KEY: SYNTHETIC_SECRET,
  ONTOS_SHELL_GATEWAY_BASE_URL: 'https://shell.example',
};
const expectedValues = OWNER_VALUES;
const redactedMap = (values: Readonly<Record<string, string>>) =>
  new Map(Object.entries(values).map(([key, value]) => [key, Redacted.make(value)]));

const unused = () => Effect.die('Unexpected API method');
const NOT_COPIED = 'must-not-copy';
const reference = (key: string) => `\${${key}}`;

const fixture = (
  options: {
    readonly config?: {
      readonly ALL_RELEASE_SECRETS?: string | null;
      readonly ZEROPS_OUTBOX_WORKER_HOST_SERVICE_ID?: string;
      readonly ZEROPS_PROJECT_ID?: string;
    };
    readonly host?: Readonly<Record<string, string>>;
    readonly hostName?: string;
    readonly owner?: unknown;
    readonly rawJson?: string;
    readonly serviceListing?: string;
  } = {},
) => {
  const host = redactedMap(options.host ?? {});
  const writes: { readonly content: Redacted.Redacted; readonly key: string; readonly serviceId: string }[] = [];
  const deletes: { readonly key: string; readonly serviceId: string }[] = [];
  const reads: string[] = [];
  const commands: OpsCommand[] = [];
  let failRead = false;
  let failWrite = false;
  let discardWrite = false;
  let discardDelete = false;
  let afterWrite: (() => void) | undefined;
  const serviceValues = new Map([['host-id', host]]);
  const serviceNames = new Map([['host-id', options.hostName ?? 'outboxworkerhost']]);
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
    deleteServiceSecret: (serviceId, key) =>
      Effect.suspend(() => {
        if (failWrite) {
          return Effect.fail(new ZeropsApiError({ cause: SYNTHETIC_SECRET, message: SYNTHETIC_SECRET }));
        }
        deletes.push({ key, serviceId });
        if (!discardDelete) {
          host.delete(key);
        }
        return Effect.void;
      }),
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
            options.serviceListing ?? '│ host-id │ outboxworkerhost │ ACTIVE │\n│ migrator-id │ migrator │ ACTIVE │'
          );
        }),
    }),
    ConfigProvider.layer(
      ConfigProvider.fromUnknown({
        ALL_RELEASE_SECRETS: options.rawJson ?? JSON.stringify({ [OWNER]: options.owner ?? OWNER_VALUES }),
        ZEROPS_OUTBOX_WORKER_HOST_SERVICE_ID: 'host-id',
        ZEROPS_PROJECT_ID: 'project-id',
        ...options.config,
      }),
    ),
  );
  return {
    commands,
    deletes,
    host,
    layer,
    reads,
    setAfterWrite: (action: () => void) => {
      afterWrite = action;
    },
    setDiscardDelete: () => {
      discardDelete = true;
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
    expect(report.retiredKeys).toEqual([]);
    expect(report.changed).toBe(false);
    expect(state.writes).toEqual([]);
    expect(state.reads).toEqual(['host-id']);
    expect(state.commands).toEqual([{ args: ['service', 'list', '--project-id', 'project-id'], command: 'zcli' }]);
    expect(JSON.stringify(report)).not.toContain(SYNTHETIC_SECRET);
  }),
);

it.effect('APPLY copies exact canonical values to the host only, preserves unrelated keys, and converges', () =>
  Effect.gen(function* applyCanonicalConfiguration() {
    const state = fixture({
      host: { COMMERCE_PORTAL_AUTH_URL: OWNER_VALUES.COMMERCE_PORTAL_AUTH_URL, KEEP: 'existing' },
    });
    const first = yield* enrollmentRecoveryHostConfig('apply').pipe(Effect.provide(state.layer));
    expect(first.createdKeys).toHaveLength(5);
    // A created secret reaches the host only when it restarts, so the release must redeploy it.
    expect(first.changed).toBe(true);
    expect(state.writes.every(({ serviceId }) => serviceId === 'host-id')).toBe(true);
    for (const [key, value] of Object.entries(expectedValues)) {
      expect(Redacted.value(state.host.get(key) ?? Redacted.make('missing'))).toBe(value);
    }
    expect(Redacted.value(state.host.get('KEEP') ?? Redacted.make('missing'))).toBe('existing');
    const again = yield* enrollmentRecoveryHostConfig('apply').pipe(Effect.provide(state.layer));
    expect(again.createdKeys).toEqual([]);
    expect(again.changed).toBe(false);
    expect(state.writes).toHaveLength(5);
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
      [RETIRED_KEY]: NOT_COPIED,
    };
    const state = fixture({ rawJson: JSON.stringify({ foreign: { key: 123 }, [OWNER]: owner }) });
    yield* enrollmentRecoveryHostConfig('apply').pipe(Effect.provide(state.layer));
    expect(
      Arr.sort(
        state.writes.map(({ key }) => key),
        Order.String,
      ),
    ).toEqual(Arr.sort(Object.keys(expectedValues), Order.String));
    expect(state.host.has(RETIRED_KEY)).toBe(false);
    expect(state.host.has(ADMIN_KEY)).toBe(false);
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
      { serviceListing: '│ host-id │ migrator │ ACTIVE │' },
      { serviceListing: '│ other-id │ outboxworkerhost │ ACTIVE │' },
      { config: { ZEROPS_OUTBOX_WORKER_HOST_SERVICE_ID: '../host-id' } },
      { config: { ZEROPS_PROJECT_ID: 'project id' } },
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

it.effect('removes the retired portal provider URL from the host, and VERIFY refuses a host still carrying it', () =>
  Effect.gen(function* retirePortalProviderUrl() {
    const state = fixture({ host: { ...expectedValues, KEEP: 'existing', [RETIRED_KEY]: RETIRED_URL } });
    const planned = yield* enrollmentRecoveryHostConfig('check').pipe(Effect.provide(state.layer));
    expect(planned.retiredKeys).toEqual([RETIRED_KEY]);
    expect(planned.changed).toBe(false);
    expect(state.deletes).toEqual([]);
    expectSafeFailure(
      yield* enrollmentRecoveryHostConfig('verify').pipe(Effect.provide(state.layer), Effect.result),
      'retired-value-present',
    );

    const applied = yield* enrollmentRecoveryHostConfig('apply').pipe(Effect.provide(state.layer));
    expect(applied.retiredKeys).toEqual([RETIRED_KEY]);
    expect(applied.changed).toBe(true);
    expect(state.deletes).toEqual([{ key: RETIRED_KEY, serviceId: 'host-id' }]);
    expect(state.host.has(RETIRED_KEY)).toBe(false);
    expect(Redacted.value(state.host.get('KEEP') ?? Redacted.make('missing'))).toBe('existing');
    expect(state.writes).toEqual([]);
    expect(JSON.stringify(applied)).not.toContain(RETIRED_URL);

    expect((yield* enrollmentRecoveryHostConfig('apply').pipe(Effect.provide(state.layer))).retiredKeys).toEqual([]);
    expect(state.deletes).toHaveLength(1);
    yield* enrollmentRecoveryHostConfig('verify').pipe(Effect.provide(state.layer));
  }),
);

it.effect('fails APPLY when a retired key survives its deletion', () =>
  Effect.gen(function* detectSurvivingRetiredKey() {
    const state = fixture({ host: { ...expectedValues, [RETIRED_KEY]: RETIRED_URL } });
    state.setDiscardDelete();
    expectSafeFailure(
      yield* enrollmentRecoveryHostConfig('apply').pipe(Effect.provide(state.layer), Effect.result),
      'retired-value-present',
    );
  }),
);

it.effect('a mismatch in the final managed key blocks all writes in every mode, never rotating', () =>
  Effect.gen(function* rejectExistingMismatchesBeforeWrites() {
    for (const mode of ['check', 'apply', 'verify'] as const) {
      const state = fixture({ host: { COMMERCE_PORTAL_AUTH_URL: 'https://other.example' } });
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
      changed.host.set('COMMERCE_PORTAL_AUTH_URL', Redacted.make('https://other.example'));
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
    for (const kind of ['read', 'write', 'delete'] as const) {
      const state = fixture(kind === 'delete' ? { host: { ...expectedValues, [RETIRED_KEY]: RETIRED_URL } } : {});
      if (kind === 'read') {
        state.setFailRead();
      } else {
        // The fake fails creates and deletes alike; a host carrying only a retired key reaches the delete.
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
