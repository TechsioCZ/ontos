import { NodeRuntime, NodeServices } from '@effect/platform-node';
import { Config, Console, Effect, Layer, Redacted, Schema } from 'effect';
import { Command } from 'effect/unstable/cli';
import { FetchHttpClient } from 'effect/unstable/http';

import { ZeropsPublicApi, ZeropsPublicApiLive } from '../zerops-public-api.mts';
import type { OpsShell } from './ops-shell.mts';
import { OpsShellLive } from './ops-shell.mts';
import { listZeropsServices } from './stage-operations.mts';

const OWNER = 'commerce-customer-context';
const PORTAL_DATABASE = 'COMMERCE_PORTAL_AUTH_DATABASE_URL';
const PORTAL_ADMIN_DATABASE = 'COMMERCE_PORTAL_AUTH_DATABASE_ADMIN_URL';
const REQUIRED_OWNER_KEYS = [
  'COMMERCE_PORTAL_AUTH_URL',
  'COMMERCE_PORTAL_AUTH_SECRET',
  'COMMERCE_CORE_IDENTITY_BASE_URL',
  'COMMERCE_CORE_IDENTITY_API_KEY',
  'ONTOS_SHELL_GATEWAY_BASE_URL',
  'ONTOS_COMMERCE_CUSTOMER_CONTEXT_GATEWAY_API_KEY',
] as const;
// Only settings consumed by the recovery graph. No composition, admin, deployment or grant data.
const OPTIONAL_OWNER_KEYS = [
  'COMMERCE_PORTAL_AUTH_NODE_ENV',
  'COMMERCE_PORTAL_AUTH_TRUSTED_ORIGINS',
  'COMMERCE_PORTAL_AUTH_TRUSTED_PROXIES',
  'COMMERCE_PORTAL_AUTH_SECRETS',
  'EMAIL_PROVIDER',
  'SMTP_HOST',
  'SMTP_PORT',
  'SMTP_FROM',
  'SMTP_SECURE',
  'SMTP_USER',
  'SMTP_PASSWORD',
  'SMTP_TIMEOUT_MS',
  'ONTOS_EMAIL_FROM',
] as const;
const ManagedKeySchema = Schema.Literals([...REQUIRED_OWNER_KEYS, ...OPTIONAL_OWNER_KEYS, PORTAL_DATABASE]);
type ManagedKey = typeof ManagedKeySchema.Type;
const ModeSchema = Schema.Literals(['check', 'apply', 'verify']);
export type EnrollmentRecoveryHostConfigMode = typeof ModeSchema.Type;
const CANONICAL_VALUE_INVALID = 'canonical-value-invalid';
const SERVICE_IDENTITY_INVALID = 'service-identity-invalid';
const PORTAL_DATABASE_PAIR_INVALID = 'portal-database-pair-invalid';
const PROTECTED_API_UNAVAILABLE = 'protected-api-unavailable';
const CONFIGURATION_UNAVAILABLE = 'configuration-unavailable';
const DATABASE_REFERENCE_UNAVAILABLE = 'database-reference-unavailable';

export class EnrollmentRecoveryHostConfigError extends Schema.TaggedError<EnrollmentRecoveryHostConfigError>()(
  'EnrollmentRecoveryHostConfigError',
  {
    key: Schema.optionalKey(ManagedKeySchema),
    reason: Schema.Literals([
      CONFIGURATION_UNAVAILABLE,
      'canonical-owner-invalid',
      CANONICAL_VALUE_INVALID,
      SERVICE_IDENTITY_INVALID,
      PORTAL_DATABASE_PAIR_INVALID,
      PROTECTED_API_UNAVAILABLE,
      DATABASE_REFERENCE_UNAVAILABLE,
      'existing-value-mismatch',
      'host-value-missing',
    ]),
  },
) {}

type FailureReason = EnrollmentRecoveryHostConfigError['reason'];
const failure = (reason: FailureReason, key?: ManagedKey) =>
  key === undefined
    ? new EnrollmentRecoveryHostConfigError({ reason })
    : new EnrollmentRecoveryHostConfigError({ key, reason });

// Drop all provider/decoder causes: they can contain tokens, complete JSON documents or DB URLs.
const protectedRead = <A, E, R>(operation: Effect.Effect<A, E, R>) =>
  operation.pipe(Effect.catchCause(() => Effect.fail(failure(PROTECTED_API_UNAVAILABLE))));

const opaqueValue = (value: string) => {
  const text = value.trim();
  return (
    text.length > 0 &&
    !/^(?:redacted|[<[]redacted[>\]]|\*+)$/iu.test(text) &&
    !/\$\{/u.test(text) &&
    !text.includes('\0')
  );
};
const HttpEndpoint = Schema.URLFromString.check(
  Schema.makeFilter((url) =>
    (url.protocol === 'http:' || url.protocol === 'https:') &&
    url.hostname !== '' &&
    url.username === '' &&
    url.password === '' &&
    url.search === '' &&
    url.hash === ''
      ? undefined
      : 'Invalid endpoint',
  ),
);
const validateEndpoint = (value: string, key: ManagedKey) =>
  Schema.decodeUnknownEffect(HttpEndpoint)(value).pipe(
    Effect.mapError(() => failure(CANONICAL_VALUE_INVALID, key)),
    Effect.asVoid,
  );

const validateOwnerValue = (key: ManagedKey, value: string) =>
  Effect.gen(function* validateCanonicalOwnerValue() {
    if (!opaqueValue(value)) {
      return yield* failure(CANONICAL_VALUE_INVALID, key);
    }
    if (
      key === 'COMMERCE_PORTAL_AUTH_URL' ||
      key === 'COMMERCE_CORE_IDENTITY_BASE_URL' ||
      key === 'ONTOS_SHELL_GATEWAY_BASE_URL'
    ) {
      yield* validateEndpoint(value, key);
    }
    if (
      (key === 'COMMERCE_PORTAL_AUTH_SECRET' && value.trim().length < 32) ||
      (key === 'COMMERCE_CORE_IDENTITY_API_KEY' && value.trim().length < 16)
    ) {
      return yield* failure(CANONICAL_VALUE_INVALID, key);
    }
    if (key === 'COMMERCE_PORTAL_AUTH_TRUSTED_ORIGINS') {
      for (const origin of value.split(',').filter((item) => item.trim() !== '')) {
        yield* validateEndpoint(origin.trim(), key);
      }
    }
    if (key === 'COMMERCE_PORTAL_AUTH_SECRETS') {
      const versions = new Set<number>();
      for (const entry of value.split(',')) {
        const separator = entry.indexOf(':');
        const versionText = entry.slice(0, separator).trim();
        const version = Number(versionText);
        if (
          separator < 1 ||
          !/^\d+$/u.test(versionText) ||
          !Number.isSafeInteger(version) ||
          versions.has(version) ||
          entry.slice(separator + 1).trim().length < 32
        ) {
          return yield* failure(CANONICAL_VALUE_INVALID, key);
        }
        versions.add(version);
      }
    }
    return yield* Effect.void;
  });

const canonicalOwner = Effect.gen(function* readCanonicalOwner() {
  const configured = yield* Config.Redacted('ALL_RELEASE_SECRETS').pipe(
    Effect.mapError(() => failure(CONFIGURATION_UNAVAILABLE)),
  );
  // Ignore foreign owners; the selected owner has the same string-record contract as the uploader.
  const decoded = yield* Schema.decodeUnknownEffect(
    Schema.fromJsonString(Schema.Struct({ [OWNER]: Schema.Record(Schema.String, Schema.String) })),
  )(Redacted.value(configured)).pipe(Effect.mapError(() => failure('canonical-owner-invalid')));
  const owner = decoded[OWNER];
  const desired = new Map<ManagedKey, Redacted.Redacted>();
  for (const key of REQUIRED_OWNER_KEYS) {
    const value = owner[key];
    if (value === undefined) {
      return yield* failure(CANONICAL_VALUE_INVALID, key);
    }
    yield* validateOwnerValue(key, value);
    desired.set(key, Redacted.make(value));
  }
  for (const key of OPTIONAL_OWNER_KEYS) {
    const value = owner[key];
    if (value !== undefined) {
      yield* validateOwnerValue(key, value);
      desired.set(key, Redacted.make(value));
    }
  }
  return desired;
});

const serviceIds = Effect.gen(function* readProtectedServiceIds() {
  const ids = yield* Config.all({
    host: Config.String('ZEROPS_OUTBOX_WORKER_HOST_SERVICE_ID'),
    migrator: Config.String('ZEROPS_MIGRATOR_SERVICE_ID'),
    project: Config.String('ZEROPS_PROJECT_ID'),
  }).pipe(Effect.mapError(() => failure(CONFIGURATION_UNAVAILABLE)));
  if (
    !/^[A-Za-z0-9_-]{1,128}$/u.test(ids.host) ||
    !/^[A-Za-z0-9_-]{1,128}$/u.test(ids.migrator) ||
    !/^[A-Za-z0-9_-]{1,128}$/u.test(ids.project) ||
    ids.host === ids.migrator
  ) {
    return yield* failure(SERVICE_IDENTITY_INVALID);
  }
  const api = yield* ZeropsPublicApi;
  const services = yield* protectedRead(listZeropsServices(ids.project));
  const databases = services.filter(({ hostname }) => hostname === 'db18');
  const [database] = databases;
  if (
    databases.length !== 1 ||
    database === undefined ||
    !/^[A-Za-z0-9_-]{1,128}$/u.test(database.id) ||
    database.id === ids.host ||
    database.id === ids.migrator ||
    !services.some(({ hostname, id }) => hostname === 'outboxworkerhost' && id === ids.host) ||
    !services.some(({ hostname, id }) => hostname === 'migrator' && id === ids.migrator)
  ) {
    return yield* failure(SERVICE_IDENTITY_INVALID);
  }
  const host = yield* protectedRead(api.serviceStack(ids.host));
  const migrator = yield* protectedRead(api.serviceStack(ids.migrator));
  const db = yield* protectedRead(api.serviceStack(database.id));
  if (host.name !== 'outboxworkerhost' || migrator.name !== 'migrator' || db.name !== 'db18') {
    return yield* failure(SERVICE_IDENTITY_INVALID);
  }
  return { ...ids, database: database.id };
});

const DATABASE_REFERENCES = new Map([
  ['db18_hostname', 'hostname'],
  ['db18_port', 'port'],
  ['db18_dbName', 'dbName'],
  ['db18_superUser', 'superUser'],
  ['db18_superUserPassword', 'superUserPassword'],
]);
const referenceTextValid = (key: string, text: string) => {
  if (key === 'hostname') {
    return /^[A-Za-z0-9.-]+$/u.test(text);
  }
  if (key === 'port') {
    return /^\d+$/u.test(text) && Number(text) >= 1 && Number(text) <= 65_535;
  }
  return true;
};
const resolvePortalReferences = (
  configured: Redacted.Redacted | undefined,
  database: ReadonlyMap<string, Redacted.Redacted>,
  administrative: boolean,
) =>
  Effect.gen(function* resolveAllowlistedPortalReferences() {
    if (configured === undefined) {
      return yield* failure(PORTAL_DATABASE_PAIR_INVALID);
    }
    let resolved = Redacted.value(configured);
    for (const match of resolved.matchAll(/\$\{(?<reference>[^}]+)\}/gu)) {
      const name = match.groups?.reference ?? '';
      const key = DATABASE_REFERENCES.get(name);
      const value = key === undefined ? undefined : database.get(key);
      if (
        key === undefined ||
        value === undefined ||
        !opaqueValue(Redacted.value(value)) ||
        (!administrative && (key === 'superUser' || key === 'superUserPassword'))
      ) {
        return yield* failure(DATABASE_REFERENCE_UNAVAILABLE);
      }
      const text = Redacted.value(value);
      if (!referenceTextValid(key, text)) {
        return yield* failure(DATABASE_REFERENCE_UNAVAILABLE);
      }
      const replacement = yield* Effect.try({
        catch: () => failure(DATABASE_REFERENCE_UNAVAILABLE),
        try: () => (key === 'hostname' || key === 'port' ? text : encodeURIComponent(text)),
      });
      resolved = resolved.replaceAll(match[0], replacement);
    }
    if (!opaqueValue(resolved)) {
      return yield* failure(DATABASE_REFERENCE_UNAVAILABLE);
    }
    return Redacted.make(resolved);
  });

const IDENTITY_PARAMETERS = new Set(['db', 'database', 'dbname', 'host', 'hostaddr', 'port', 'user']);
const portalConnection = (value: Redacted.Redacted | undefined) =>
  Effect.gen(function* validatePortalConnection() {
    if (value === undefined || !opaqueValue(Redacted.value(value))) {
      return yield* failure(PORTAL_DATABASE_PAIR_INVALID);
    }
    const url = yield* Schema.decodeUnknownEffect(Schema.URLFromString)(Redacted.value(value)).pipe(
      Effect.mapError(() => failure(PORTAL_DATABASE_PAIR_INVALID)),
    );
    const identity = yield* Effect.try({
      catch: () => failure(PORTAL_DATABASE_PAIR_INVALID),
      try: () => ({
        database: decodeURIComponent(url.pathname.replace(/^\/+/u, '')),
        user: decodeURIComponent(url.username),
      }),
    });
    const port = url.port === '' ? 5432 : Number(url.port);
    if (
      (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') ||
      url.hostname === '' ||
      identity.database === '' ||
      identity.user === '' ||
      url.hash !== '' ||
      !Number.isSafeInteger(port) ||
      port < 1 ||
      port > 65_535 ||
      [...url.searchParams.keys()].some((key) => IDENTITY_PARAMETERS.has(key.toLowerCase()))
    ) {
      return yield* failure(PORTAL_DATABASE_PAIR_INVALID);
    }
    return { database: identity.database, host: url.hostname, port, user: identity.user, value };
  });

const portalRuntimeUrl = (
  secrets: ReadonlyMap<string, Redacted.Redacted>,
  database: ReadonlyMap<string, Redacted.Redacted>,
) =>
  Effect.gen(function* readCanonicalPortalDatabasePair() {
    const runtime = yield* portalConnection(
      yield* resolvePortalReferences(secrets.get(PORTAL_DATABASE), database, false),
    );
    const admin = yield* portalConnection(
      yield* resolvePortalReferences(secrets.get(PORTAL_ADMIN_DATABASE), database, true),
    );
    if (
      runtime.user === admin.user ||
      runtime.database !== admin.database ||
      runtime.host !== admin.host ||
      runtime.port !== admin.port
    ) {
      return yield* failure(PORTAL_DATABASE_PAIR_INVALID);
    }
    // The admin value is evidence of separation only. It never enters the host configuration.
    return runtime.value;
  });

const compare = (
  desired: ReadonlyMap<ManagedKey, Redacted.Redacted>,
  existing: ReadonlyMap<string, Redacted.Redacted>,
  requirePresent: boolean,
) =>
  Effect.gen(function* compareEveryManagedKey() {
    const missing: ManagedKey[] = [];
    for (const [key, expected] of desired) {
      const actual = existing.get(key);
      if (actual === undefined) {
        missing.push(key);
      } else if (Redacted.value(actual) !== Redacted.value(expected)) {
        return yield* failure('existing-value-mismatch', key);
      }
    }
    const [firstMissing] = missing;
    if (requirePresent && firstMissing !== undefined) {
      return yield* failure('host-value-missing', firstMissing);
    }
    return missing;
  });

/** Safe output only. A successful CHECK plans absent keys, not runtime readiness or permission proof. */
const ReportSchema = Schema.Struct({
  createdKeys: Schema.Array(ManagedKeySchema),
  managedKeys: Schema.Array(ManagedKeySchema),
  missingKeys: Schema.Array(ManagedKeySchema),
  mode: ModeSchema,
});
export type EnrollmentRecoveryHostConfigReport = typeof ReportSchema.Type;

/**
 * Reuses canonical owner credentials and the existing migrator runtime identity. No dotenv, DB
 * connection, credential generation, rotation, grant change, or project-wide secret propagation.
 */
export const enrollmentRecoveryHostConfig = (mode: EnrollmentRecoveryHostConfigMode) =>
  Effect.gen(function* reconcileEnrollmentRecoveryHostConfig(): Effect.fn.Return<
    EnrollmentRecoveryHostConfigReport,
    EnrollmentRecoveryHostConfigError,
    ZeropsPublicApi | typeof OpsShell.Identifier
  > {
    const desired = yield* canonicalOwner;
    const ids = yield* serviceIds;
    const api = yield* ZeropsPublicApi;
    const migrator = yield* protectedRead(api.serviceSecrets(ids.migrator));
    const database = yield* protectedRead(api.serviceSecrets(ids.database));
    desired.set(PORTAL_DATABASE, yield* portalRuntimeUrl(migrator, database));
    const missingKeys = yield* compare(desired, yield* protectedRead(api.serviceSecrets(ids.host)), mode === 'verify');
    const createdKeys: ManagedKey[] = [];
    if (mode === 'apply') {
      for (const [key, value] of desired) {
        // Re-read and compare the entire plan before each create. The API has no atomic batch/CAS;
        // a failure may leave correct additions behind, and a rerun converges without overwrites.
        const missing = yield* compare(desired, yield* protectedRead(api.serviceSecrets(ids.host)), false);
        if (missing.includes(key)) {
          yield* protectedRead(api.createServiceSecret(ids.host, key, Redacted.value(value)));
          createdKeys.push(key);
        }
      }
      yield* compare(desired, yield* protectedRead(api.serviceSecrets(ids.host)), true);
    }
    return { createdKeys, managedKeys: [...desired.keys()], missingKeys, mode };
  });

if (import.meta.main) {
  const modeCommand = (mode: EnrollmentRecoveryHostConfigMode) =>
    Command.make(mode, {}, () =>
      enrollmentRecoveryHostConfig(mode).pipe(
        Effect.flatMap(Schema.encodeEffect(Schema.fromJsonString(ReportSchema))),
        Effect.flatMap(Console.log),
      ),
    );
  const cli = Command.make('enrollment-recovery-host-config').pipe(
    Command.withSubcommands([modeCommand('check'), modeCommand('apply'), modeCommand('verify')]),
  );
  NodeRuntime.runMain(
    Layer.build(
      Layer.effectDiscard(Command.run({ version: '1.0.0' })(cli)).pipe(
        Layer.provide(Layer.merge(ZeropsPublicApiLive, OpsShellLive)),
        Layer.provide(Layer.merge(NodeServices.layer, FetchHttpClient.layer)),
      ),
    ).pipe(Effect.scoped),
  );
}
