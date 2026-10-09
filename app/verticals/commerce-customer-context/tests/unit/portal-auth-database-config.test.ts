import { Effect, Option, Redacted } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  CommercePortalAuthDatabaseConfigError,
  parseCommercePortalAuthDatabaseAdminConfig,
  parseCommercePortalAuthDatabaseConfig,
  parseOptionalCommercePortalAuthDatabaseConfig,
} from '../../scripts/portal-auth-database-config.mts';

const adminUrl = 'postgresql://portal_admin:admin-secret@db.example.test:5432/portal_auth';
const runtimeUrl = 'postgresql://portal_runtime:runtime-secret@db.example.test:5432/portal_auth';

it.effect('decodes independent administrative and runtime identities into a redacted pair', () =>
  Effect.gen(function* decodePair() {
    const pair = yield* parseCommercePortalAuthDatabaseConfig({
      COMMERCE_PORTAL_AUTH_DATABASE_ADMIN_URL: adminUrl,
      COMMERCE_PORTAL_AUTH_DATABASE_URL: runtimeUrl,
    });

    expect(pair.admin.database).toBe('portal_auth');
    expect(pair.admin.host).toBe('db.example.test');
    expect(pair.admin.port).toBe(5432);
    expect(pair.admin.user).toBe('portal_admin');
    expect(pair.runtime.database).toBe('portal_auth');
    expect(pair.runtime.host).toBe('db.example.test');
    expect(pair.runtime.port).toBe(5432);
    expect(pair.runtime.user).toBe('portal_runtime');
    expect(Redacted.value(pair.admin.connectionString)).toBe(adminUrl);
    expect(Redacted.value(pair.runtime.connectionString)).toBe(runtimeUrl);
  }),
);

it.effect('allows an administrative-only config for the migration boundary', () =>
  Effect.gen(function* decodeAdministrativeConfig() {
    const admin = yield* parseCommercePortalAuthDatabaseAdminConfig({
      COMMERCE_PORTAL_AUTH_DATABASE_ADMIN_URL: adminUrl,
    });

    expect(admin.user).toBe('portal_admin');
    expect(admin.database).toBe('portal_auth');
  }),
);

it.effect('returns no provider config only when both provider URLs are absent', () =>
  Effect.gen(function* decodeOptionalConfig() {
    const config = yield* parseOptionalCommercePortalAuthDatabaseConfig({});

    expect(Option.isNone(config)).toBe(true);
  }),
);

it.effect('rejects partial provider configuration with a sanitized typed error', () =>
  Effect.gen(function* rejectPartialConfig() {
    const failure = yield* Effect.flip(
      parseOptionalCommercePortalAuthDatabaseConfig({
        COMMERCE_PORTAL_AUTH_DATABASE_ADMIN_URL: adminUrl,
      }),
    );

    expect(failure).toBeInstanceOf(CommercePortalAuthDatabaseConfigError);
    expect(failure.reason).toBe(
      'Commerce portal authentication requires both administrative and runtime database URLs',
    );
    expect(failure.reason).not.toContain('secret');
    expect(failure.reason).not.toContain('postgres');
  }),
);

it.effect('rejects identity overrides and mismatched physical targets before any connection is opened', () =>
  Effect.forEach(
    [
      {
        COMMERCE_PORTAL_AUTH_DATABASE_ADMIN_URL: `${adminUrl}?host=other.example.test`,
        COMMERCE_PORTAL_AUTH_DATABASE_URL: runtimeUrl,
      },
      {
        COMMERCE_PORTAL_AUTH_DATABASE_ADMIN_URL: `${adminUrl}?dbname=other_database`,
        COMMERCE_PORTAL_AUTH_DATABASE_URL: runtimeUrl,
      },
      {
        COMMERCE_PORTAL_AUTH_DATABASE_ADMIN_URL: `${adminUrl}?user=other_admin`,
        COMMERCE_PORTAL_AUTH_DATABASE_URL: runtimeUrl,
      },
      {
        COMMERCE_PORTAL_AUTH_DATABASE_ADMIN_URL: adminUrl,
        COMMERCE_PORTAL_AUTH_DATABASE_URL:
          'postgresql://portal_runtime:runtime-secret@other.example.test:5432/portal_auth',
      },
      {
        COMMERCE_PORTAL_AUTH_DATABASE_ADMIN_URL: adminUrl,
        COMMERCE_PORTAL_AUTH_DATABASE_URL:
          'postgresql://portal_runtime:runtime-secret@db.example.test:6432/portal_auth',
      },
      {
        COMMERCE_PORTAL_AUTH_DATABASE_ADMIN_URL: adminUrl,
        COMMERCE_PORTAL_AUTH_DATABASE_URL:
          'postgresql://portal_runtime:runtime-secret@db.example.test:5432/other_database',
      },
    ],
    (environment) =>
      Effect.gen(function* rejectInvalidTarget() {
        const failure = yield* Effect.flip(parseCommercePortalAuthDatabaseConfig(environment));
        expect(failure).toBeInstanceOf(CommercePortalAuthDatabaseConfigError);
        expect(failure.reason).not.toContain('secret');
        expect(failure.reason).not.toContain('postgresql://');
      }),
    { concurrency: 'unbounded' },
  ),
);
