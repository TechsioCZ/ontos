import { Cause, Effect, Exit, Layer, Option, Redacted, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { OAuthAuthenticationAudit } from '../../../../../packages/core-runtime/src/auth/oauth-authentication-audit.ts';
import { OAuthEndpointGuards, OAuthEndpointGuardsLive } from '../../../api/auth/oauth-server/endpoint-guards.ts';
import { OAuthGuardSessions } from '../../../api/auth/oauth-server/guard-sessions.ts';
import { OAuthGrantRegistry } from '../../../../../packages/core-runtime/src/auth/oauth-grant-registry-service.ts';
import { OAuthGrantRegistryUnavailable } from '../../../../../packages/core-runtime/src/auth/oauth-grant-registry-unavailable.ts';
import { OAuthGrantOwners } from '../../../../../packages/core-runtime/src/auth/oauth-grant-owners.ts';
import { OAuthCredentials } from '../../../api/auth/db/oauth-credentials.ts';
import { OAuthCredentialsUnavailable } from '../../../api/auth/db/oauth-credentials-unavailable.ts';
import { ConnectionUnavailable } from '../../../api/oauth-connections/errors.ts';
import {
  OAuthEndpointGuardData,
  OAuthEndpointGuardDataLive,
  OAuthGrantOwnersLive,
} from '../../../api/oauth-connections/grant-store.ts';
import type { OAuthRefreshGuardRow } from '../../../api/oauth-connections/types.ts';
import { grantRegistryFixture, retainedGrant } from './grant-registry-fixture.ts';

const token = {
  clientId: retainedGrant.clientId,
  id: 'refresh-row',
  referenceId: retainedGrant.grantId,
  revoked: retainedGrant.createdAt,
  rotatedAt: retainedGrant.createdAt,
  rotationReplayExpiresAt: null,
  userId: retainedGrant.userId,
};
const row: OAuthRefreshGuardRow = { ...token, grant: Option.some(retainedGrant) };
const credentials = (
  overrides: Partial<(typeof OAuthCredentials)['Service']> = {},
): (typeof OAuthCredentials)['Service'] => ({
  loadRefresh: () => Effect.succeed(Option.some(token)),
  loadUserAccount: () => Effect.succeed(Option.none()),
  revokeFamily: () => Effect.void,
  ...overrides,
});
const dataLayer = (registry: (typeof OAuthGrantRegistry)['Service'], auth = credentials()) =>
  OAuthEndpointGuardDataLive.pipe(
    Layer.provide(Layer.merge(Layer.succeed(OAuthGrantRegistry, registry), Layer.succeed(OAuthCredentials, auth))),
  );

it.effect(
  'Core authorization disables before separately committed Auth family cleanup; cleanup failure propagates',
  () =>
    Effect.gen(function* cleanupFailure() {
      const events: string[] = [];
      const registry = grantRegistryFixture({
        setGrantStatus: () =>
          Effect.sync(() => {
            events.push('core-committed-disabled');
            return Option.some({ ...retainedGrant, status: 'revoked' as const });
          }),
      });
      const auth = credentials({
        revokeFamily: () =>
          Effect.sync(() => {
            events.push('auth-cleanup');
          }).pipe(Effect.andThen(Effect.fail(new OAuthCredentialsUnavailable({ cause: 'failed' })))),
      });
      const result = yield* Effect.gen(function* revoke() {
        yield* (yield* OAuthEndpointGuardData).revokeFamily(row);
      }).pipe(Effect.provide(dataLayer(registry, auth)), Effect.exit);
      expect(Exit.isFailure(result)).toBe(true);
      expect(events).toEqual(['core-committed-disabled', 'auth-cleanup']);
    }),
);

it.effect('the existing observer records denied reuse even after revoked-grant cleanup fails', () =>
  Effect.gen(function* retainedDenial() {
    const events: string[] = [];
    const cleanupError = new OAuthCredentialsUnavailable({ cause: 'cleanup failed' });
    const terminal = { ...retainedGrant, status: 'revoked' as const };
    const registry = grantRegistryFixture({
      findGrant: () => Effect.succeed(Option.some(terminal)),
      setGrantStatus: () =>
        Effect.sync(() => {
          events.push('core-disabled');
          return Option.some(terminal);
        }),
    });
    const auth = credentials({
      revokeFamily: () =>
        Effect.sync(() => {
          events.push('auth-failed');
        }).pipe(Effect.andThen(Effect.fail(cleanupError))),
    });
    const observed: Parameters<(typeof OAuthAuthenticationAudit)['Service']['record']>[0][] = [];
    const layer = OAuthEndpointGuardsLive.pipe(
      Layer.provide(
        Layer.mergeAll(
          dataLayer(registry, auth),
          Layer.succeed(OAuthGuardSessions, { read: () => Effect.succeed(Option.none()) }),
          Layer.succeed(OAuthAuthenticationAudit, {
            record: (observation) =>
              Effect.sync(() => {
                events.push('denial-observed');
                observed.push(observation);
              }),
          }),
        ),
      ),
    );
    const result = yield* Effect.gen(function* reuse() {
      return yield* (yield* OAuthEndpointGuards).refreshTokenStatus(Redacted.make('framework-refresh-token'), {
        revokeOnReuse: true,
      });
    }).pipe(Effect.provide(layer), Effect.exit);
    expect(Exit.isFailure(result)).toBe(true);
    if (Exit.isFailure(result)) {
      expect(Cause.hasDies(result.cause)).toBe(true);
      const defect = yield* Schema.decodeUnknownEffect(Schema.instanceOf(ConnectionUnavailable))(
        Cause.squash(result.cause),
      );
      expect(defect.cause).toBe(cleanupError);
    }
    expect(events).toEqual(['core-disabled', 'auth-failed', 'denial-observed']);
    expect(observed).toHaveLength(1);
    expect(observed[0]).toMatchObject({
      authBindingId: terminal.authBindingId,
      outcome: 'denied',
      outcomeCode: 'refresh_reuse',
      principalId: terminal.userPrincipalId,
    });
  }),
);

it.effect('Core revocation failure prevents Auth cleanup and never becomes a successful family revocation', () =>
  Effect.gen(function* coreFailure() {
    const events: string[] = [];
    const registry = grantRegistryFixture({
      setGrantStatus: () => Effect.fail(new OAuthGrantRegistryUnavailable({ cause: 'failed' })),
    });
    const auth = credentials({
      revokeFamily: () =>
        Effect.sync(() => {
          events.push('auth-cleanup');
        }),
    });
    const result = yield* Effect.gen(function* revoke() {
      yield* (yield* OAuthEndpointGuardData).revokeFamily(row);
    }).pipe(Effect.provide(dataLayer(registry, auth)), Effect.exit);
    expect(Exit.isFailure(result)).toBe(true);
    expect(events).toEqual([]);
  }),
);

it.effect('a disappeared retained grant cannot turn failed disablement into successful Auth cleanup', () =>
  Effect.gen(function* missingRetainedGrant() {
    let cleaned = false;
    const registry = grantRegistryFixture({ setGrantStatus: () => Effect.succeed(Option.none()) });
    const auth = credentials({
      revokeFamily: () =>
        Effect.sync(() => {
          cleaned = true;
        }),
    });
    const result = yield* Effect.gen(function* revoke() {
      yield* (yield* OAuthEndpointGuardData).revokeFamily(row);
    }).pipe(Effect.provide(dataLayer(registry, auth)), Effect.exit);
    expect(Exit.isFailure(result)).toBe(true);
    expect(cleaned).toBe(false);
  }),
);

it.effect('retained revoked bindings do not require admission before family cleanup', () =>
  Effect.gen(function* terminalCleanup() {
    let revoked = false;
    const registry = grantRegistryFixture({
      setGrantStatus: () =>
        Effect.sync(() => {
          revoked = true;
          return Option.some({ ...retainedGrant, status: 'revoked' as const });
        }),
    });
    yield* Effect.gen(function* revoke() {
      yield* (yield* OAuthEndpointGuardData).revokeFamily({
        ...row,
        grant: Option.some({ ...retainedGrant, status: 'revoked' }),
      });
    }).pipe(Effect.provide(dataLayer(registry)));
    expect(revoked).toBe(true);
  }),
);

it.effect('refresh references cannot cross client or user boundaries', () =>
  Effect.gen(function* familyIsolation() {
    const registry = grantRegistryFixture({ findGrant: () => Effect.succeed(Option.some(retainedGrant)) });
    for (const foreign of [
      { ...token, clientId: 'other-client' },
      { ...token, userId: 'other-user' },
    ]) {
      const auth = credentials({ loadRefresh: () => Effect.succeed(Option.some(foreign)) });
      const result = yield* Effect.gen(function* load() {
        return yield* (yield* OAuthEndpointGuardData).loadRefresh('storage-key');
      }).pipe(Effect.provide(dataLayer(registry, auth)));
      expect(Option.isSome(result)).toBe(true);
      expect(Option.isSome(result) && Option.isNone(result.value.grant)).toBe(true);
    }
  }),
);

it.effect('consent uses the exact session lookup and requires active status', () =>
  Effect.gen(function* consentStatus() {
    const seen: unknown[] = [];
    const registry = grantRegistryFixture({
      findSessionGrant: (session) =>
        Effect.sync(() => {
          seen.push(session);
          return Option.some({ ...retainedGrant, status: 'draft' as const });
        }),
    });
    const allowed = yield* Effect.gen(function* consent() {
      return yield* (yield* OAuthEndpointGuardData).consentApproved({
        sessionId: 'actual-session',
        userId: 'actual-user',
      });
    }).pipe(Effect.provide(dataLayer(registry)));
    expect(allowed).toBe(false);
    expect(seen).toEqual([{ sessionId: 'actual-session', userId: 'actual-user' }]);
  }),
);

it.effect('retained grant-owner producer delegates only its finite owner query', () =>
  Effect.gen(function* retainedOwners() {
    const query = {
      grantIds: [retainedGrant.grantId],
      legalEntityId: retainedGrant.legalEntityId,
      tenantId: retainedGrant.tenantId,
    };
    const owner = {
      grantId: retainedGrant.grantId,
      legalEntityId: retainedGrant.legalEntityId,
      tenantId: retainedGrant.tenantId,
      userPrincipalId: retainedGrant.userPrincipalId,
    };
    const seen: unknown[] = [];
    const layer = OAuthGrantOwnersLive.pipe(
      Layer.provide(
        Layer.succeed(
          OAuthGrantRegistry,
          grantRegistryFixture({
            owners: (input) =>
              Effect.sync(() => {
                seen.push(input);
                return [owner];
              }),
          }),
        ),
      ),
    );
    const result = yield* Effect.gen(function* owners() {
      return yield* (yield* OAuthGrantOwners).owners(query);
    }).pipe(Effect.provide(layer));
    expect(result).toEqual([owner]);
    expect(seen).toEqual([query]);
  }),
);
