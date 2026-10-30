import { NodeRuntime, NodeServices } from '@effect/platform-node';
import { Config, Console, Effect, Layer, Redacted, Schema } from 'effect';
import { Command } from 'effect/cli';
import { FetchHttpClient } from 'effect/http';

import { ZeropsPublicApi, ZeropsPublicApiLive } from '../zerops-public-api.mts';
import type { OpsShell } from './ops-shell.mts';
import { OpsShellLive } from './ops-shell.mts';
import { listZeropsServices } from './stage-operations.mts';

const OWNER = 'commerce-customer-context';
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
/**
 * The Shell's email dispatch endpoint, under the owner's Shell gateway base URL. The host posts there only beside its
 * own ONTOS_EMAIL_DISPATCH_SECRET (the two are configured together), so it is managed only on a host that has one.
 */
const EMAIL_DISPATCH_URL = 'ONTOS_EMAIL_DISPATCH_URL';
const EMAIL_DISPATCH_SECRET = 'ONTOS_EMAIL_DISPATCH_SECRET';
const ManagedKeySchema = Schema.Literals([...REQUIRED_OWNER_KEYS, ...OPTIONAL_OWNER_KEYS, EMAIL_DISPATCH_URL]);
type ManagedKey = typeof ManagedKeySchema.Type;
/**
 * Non-secret URL and sender settings the release secret preparation derives from topology/stage-edge.json. A host
 * copy that differs is stale (a domain move), so APPLY replaces it; any other mismatch is a credential conflict.
 */
const DERIVED_KEYS: ReadonlySet<ManagedKey> = new Set([
  'COMMERCE_CORE_IDENTITY_BASE_URL',
  'COMMERCE_PORTAL_AUTH_TRUSTED_ORIGINS',
  'COMMERCE_PORTAL_AUTH_URL',
  EMAIL_DISPATCH_URL,
  'ONTOS_EMAIL_FROM',
  'ONTOS_SHELL_GATEWAY_BASE_URL',
]);
/**
 * Host settings that must not stand. The portal realm connects as the shared runtime identity the
 * deployment grants (`DATABASE_URL`), so a provider URL on the host names a role nothing grants.
 */
const RETIRED_HOST_KEYS = ['COMMERCE_PORTAL_AUTH_DATABASE_URL'] as const;
const RetiredKeySchema = Schema.Literals(RETIRED_HOST_KEYS);
type RetiredKey = typeof RetiredKeySchema.Type;
const ModeSchema = Schema.Literals(['check', 'apply', 'verify']);
export type EnrollmentRecoveryHostConfigMode = typeof ModeSchema.Type;
const CANONICAL_VALUE_INVALID = 'canonical-value-invalid';
const SERVICE_IDENTITY_INVALID = 'service-identity-invalid';
const PROTECTED_API_UNAVAILABLE = 'protected-api-unavailable';
const CONFIGURATION_UNAVAILABLE = 'configuration-unavailable';
const RETIRED_VALUE_PRESENT = 'retired-value-present';

export class EnrollmentRecoveryHostConfigError extends Schema.TaggedError<EnrollmentRecoveryHostConfigError>()(
  'EnrollmentRecoveryHostConfigError',
  {
    key: Schema.optionalKey(Schema.Union([ManagedKeySchema, RetiredKeySchema])),
    reason: Schema.Literals([
      CONFIGURATION_UNAVAILABLE,
      'canonical-owner-invalid',
      CANONICAL_VALUE_INVALID,
      SERVICE_IDENTITY_INVALID,
      PROTECTED_API_UNAVAILABLE,
      'existing-value-mismatch',
      'host-value-missing',
      RETIRED_VALUE_PRESENT,
    ]),
  },
) {}

type FailureReason = EnrollmentRecoveryHostConfigError['reason'];
const failure = (reason: FailureReason, key?: ManagedKey | RetiredKey) =>
  key === undefined
    ? new EnrollmentRecoveryHostConfigError({ reason })
    : new EnrollmentRecoveryHostConfigError({ key, reason });

// Drop all provider/decoder causes: they can contain tokens or complete JSON documents.
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
    project: Config.String('ZEROPS_PROJECT_ID'),
  }).pipe(Effect.mapError(() => failure(CONFIGURATION_UNAVAILABLE)));
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(ids.host) || !/^[A-Za-z0-9_-]{1,128}$/u.test(ids.project)) {
    return yield* failure(SERVICE_IDENTITY_INVALID);
  }
  const api = yield* ZeropsPublicApi;
  const services = yield* protectedRead(listZeropsServices(ids.project));
  if (!services.some(({ hostname, id }) => hostname === 'outboxworkerhost' && id === ids.host)) {
    return yield* failure(SERVICE_IDENTITY_INVALID);
  }
  const host = yield* protectedRead(api.serviceStack(ids.host));
  if (host.name !== 'outboxworkerhost') {
    return yield* failure(SERVICE_IDENTITY_INVALID);
  }
  return ids;
});

/** The retired keys the host still carries, in their declared order. */
const retiredPresent = (existing: ReadonlyMap<string, Redacted.Redacted>): RetiredKey[] =>
  RETIRED_HOST_KEYS.filter((key) => existing.has(key));

/** The canonical keys plus the dispatch endpoint, which joins only a host that holds its dispatch secret. */
const desiredFor = (
  canonical: ReadonlyMap<ManagedKey, Redacted.Redacted>,
  existing: ReadonlyMap<string, Redacted.Redacted>,
) => {
  const base = canonical.get('ONTOS_SHELL_GATEWAY_BASE_URL');
  if (!existing.has(EMAIL_DISPATCH_SECRET) || base === undefined) {
    return canonical;
  }
  const endpoint = `${Redacted.value(base).replace(/\/+$/u, '')}/email/dispatch`;
  return new Map([...canonical, [EMAIL_DISPATCH_URL, Redacted.make(endpoint)] as const]);
};

/** Missing keys, and stale derived keys to replace. `exact` (VERIFY) also refuses a stale derived key. */
const compare = (
  desired: ReadonlyMap<ManagedKey, Redacted.Redacted>,
  existing: ReadonlyMap<string, Redacted.Redacted>,
  exact: boolean,
) =>
  Effect.gen(function* compareEveryManagedKey() {
    const missing: ManagedKey[] = [];
    const stale: ManagedKey[] = [];
    for (const [key, expected] of desired) {
      const actual = existing.get(key);
      if (actual === undefined) {
        missing.push(key);
      } else if (Redacted.value(actual) !== Redacted.value(expected)) {
        if (exact || !DERIVED_KEYS.has(key)) {
          return yield* failure('existing-value-mismatch', key);
        }
        stale.push(key);
      }
    }
    const [firstMissing] = missing;
    if (exact && firstMissing !== undefined) {
      return yield* failure('host-value-missing', firstMissing);
    }
    return { missing, stale };
  });

/** Safe output only. A successful CHECK plans absent keys, not runtime readiness or permission proof. */
const ReportSchema = Schema.Struct({
  /**
   * APPLY only: it created, replaced or removed a host secret. Zerops hands a running container its secrets at
   * start, so the release redeploys the host even when the host artifact itself is unchanged.
   */
  changed: Schema.Boolean,
  createdKeys: Schema.Array(ManagedKeySchema),
  managedKeys: Schema.Array(ManagedKeySchema),
  missingKeys: Schema.Array(ManagedKeySchema),
  mode: ModeSchema,
  /** Stale derived keys: planned replacements for CHECK, the ones replaced for APPLY. */
  replacedKeys: Schema.Array(ManagedKeySchema),
  /** Retired keys the host carried: planned removals for CHECK, the ones removed for APPLY. */
  retiredKeys: Schema.Array(RetiredKeySchema),
});
export type EnrollmentRecoveryHostConfigReport = typeof ReportSchema.Type;

/**
 * Reuses canonical owner credentials and removes retired host settings. No dotenv, DB connection,
 * credential generation, rotation, grant change, or project-wide secret propagation.
 */
export const enrollmentRecoveryHostConfig = (mode: EnrollmentRecoveryHostConfigMode) =>
  Effect.gen(function* reconcileEnrollmentRecoveryHostConfig(): Effect.fn.Return<
    EnrollmentRecoveryHostConfigReport,
    EnrollmentRecoveryHostConfigError,
    ZeropsPublicApi | typeof OpsShell.Identifier
  > {
    const canonical = yield* canonicalOwner;
    const ids = yield* serviceIds;
    const api = yield* ZeropsPublicApi;
    const existing = yield* protectedRead(api.serviceSecrets(ids.host));
    const desired = desiredFor(canonical, existing);
    const { missing: missingKeys, stale: staleKeys } = yield* compare(desired, existing, mode === 'verify');
    const retiredKeys = retiredPresent(existing);
    const [firstRetired] = retiredKeys;
    if (mode === 'verify' && firstRetired !== undefined) {
      return yield* failure(RETIRED_VALUE_PRESENT, firstRetired);
    }
    const createdKeys: ManagedKey[] = [];
    const replacedKeys: ManagedKey[] = [];
    if (mode === 'apply') {
      for (const key of retiredKeys) {
        yield* protectedRead(api.deleteServiceSecret(ids.host, key));
      }
      for (const [key, value] of desired) {
        // Re-read and compare the entire plan before each write. The API has no atomic batch/CAS or update;
        // a failure may leave correct writes behind, and a rerun converges. Only a stale derived key is replaced.
        const current = yield* compare(desired, yield* protectedRead(api.serviceSecrets(ids.host)), false);
        if (current.stale.includes(key)) {
          yield* protectedRead(api.deleteServiceSecret(ids.host, key));
          yield* protectedRead(api.createServiceSecret(ids.host, key, Redacted.value(value)));
          replacedKeys.push(key);
        } else if (current.missing.includes(key)) {
          yield* protectedRead(api.createServiceSecret(ids.host, key, Redacted.value(value)));
          createdKeys.push(key);
        }
      }
      const applied = yield* protectedRead(api.serviceSecrets(ids.host));
      yield* compare(desired, applied, true);
      const [stillRetired] = retiredPresent(applied);
      if (stillRetired !== undefined) {
        return yield* failure(RETIRED_VALUE_PRESENT, stillRetired);
      }
    }
    return {
      changed: mode === 'apply' && (createdKeys.length > 0 || replacedKeys.length > 0 || retiredKeys.length > 0),
      createdKeys,
      managedKeys: [...desired.keys()],
      missingKeys,
      mode,
      replacedKeys: mode === 'apply' ? replacedKeys : staleKeys,
      retiredKeys,
    };
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
