import { Effect, Option, Redacted } from 'effect';
import { expect, it } from 'effect-rstest';

import { parseOptionalCommercePortalAuthConfig } from '../../api/portal-auth/provider/config.ts';

/**
 * The portal realm runs as the shared runtime identity on every host, because that identity is the
 * one the deployment migrates and grants the provider schema to. A Node host — the outbox worker
 * host on stage — once carried a second provider URL naming a role nobody granted, and every
 * recovery sweep then failed on `permission denied for schema commerce_auth`.
 */
const REALM = {
  COMMERCE_PORTAL_AUTH_SECRET: 'a'.repeat(32),
  COMMERCE_PORTAL_AUTH_URL: 'https://portal.example.test',
} as const;
const SHARED_RUNTIME_URL = 'postgresql://ontos_runtime:runtime@db.internal:5432/ontos';
const STALE_PROVIDER_URL = 'postgresql://stale_provider:stale@db.internal:5432/ontos';

const connectionOf = (environment: Parameters<typeof parseOptionalCommercePortalAuthConfig>[0]) =>
  parseOptionalCommercePortalAuthConfig(environment).pipe(
    Effect.map((configuration) => Redacted.value(Option.getOrThrow(configuration).connectionString)),
  );

it.effect('connects a Node host to the portal realm as the shared runtime identity', () =>
  Effect.gen(function* sharedRuntimeIdentity() {
    expect(
      yield* connectionOf({
        ...REALM,
        COMMERCE_PORTAL_AUTH_DATABASE_URL: STALE_PROVIDER_URL,
        DATABASE_URL: SHARED_RUNTIME_URL,
      }),
    ).toBe(SHARED_RUNTIME_URL);
  }),
);

it.effect('keeps the realm connection of a host without a shared runtime identity', () =>
  Effect.gen(function* realmOnlyHost() {
    expect(yield* connectionOf({ ...REALM, COMMERCE_PORTAL_AUTH_DATABASE_URL: STALE_PROVIDER_URL })).toBe(
      STALE_PROVIDER_URL,
    );
  }),
);
