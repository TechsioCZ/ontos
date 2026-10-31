import { PrincipalBindingMissingError, PrincipalResolver, PrincipalResolverUnavailableError } from '@app/core-runtime';
import type { PrincipalResolverService } from '@app/core-runtime';
import { makeEffectDrizzleAuthAdapter } from '@app/better-auth-effect-drizzle/server';
import { PgClient } from '@effect/sql-pg';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import { Cause, Effect, Exit, Schema } from 'effect';
import { Reactivity } from 'effect/reactivity';
import { SqlClient } from 'effect/sql';
import { expect, it } from 'effect-rstest';
import { GatewayTrustedPrincipalContextSchema } from '@app/shared-contracts';

import { AuthDatabase } from '../../api/auth/db/client.ts';
import { authDatabaseSchema, authRelations } from '../../api/auth/db/schema.ts';
import { GatewayRelayError } from '../../api/auth/gateway-relay-errors.ts';
import { validateRelayAuthentication } from '../../api/auth/gateway-relay-authentication.service.ts';
import { makePrincipalResolverDouble } from '../support/identity-service-doubles.ts';
import {
  controlledAuthConnection,
  controlledPgClient,
  relayUnitIdentity,
  relayUnitNow,
  relayUnitPrincipal,
  unitSession,
} from '../support/gateway-relay-test.ts';
import type { RelayUnitRows } from '../support/gateway-relay-test.ts';

type Principal = typeof GatewayTrustedPrincipalContextSchema.Type;

/** Real Auth query builder and validator; controlled rows are unit evidence, not Current acceptance. */
const authenticate = Effect.fn('RelayAuthenticationTest.authenticate')(function* authenticate(
  principal: Principal,
  batches: RelayUnitRows,
  overrides: Partial<PrincipalResolverService> = {},
  sqlUnavailable = false,
) {
  const controlled = controlledAuthConnection(batches, sqlUnavailable);
  const sql = yield* SqlClient.make({
    acquirer: Effect.succeed(controlled.connection),
    compiler: PgClient.makeCompiler(),
    driver: 'controlled-auth-unit',
    spanAttributes: [],
  }).pipe(Effect.provide(Reactivity.layer));
  const executor = yield* makeWithDefaults({ relations: authRelations }).pipe(
    Effect.provideService(PgClient.PgClient, controlledPgClient(sql)),
  );
  const adapter = yield* makeEffectDrizzleAuthAdapter(executor, authDatabaseSchema);
  const resolver = makePrincipalResolverDouble({
    resolveBetterAuthApiKey: () => Effect.succeed(relayUnitIdentity),
    resolveBetterAuthUserForTenant: () => Effect.succeed(relayUnitIdentity),
    ...overrides,
  });
  const result = yield* Effect.exit(
    validateRelayAuthentication(principal, relayUnitNow).pipe(
      Effect.provideService(AuthDatabase, { adapter, executor }),
      Effect.provideService(PrincipalResolver, resolver),
    ),
  );
  return { queries: controlled.queries, result };
});

const assertRejected = (result: Exit.Exit<void, unknown>, code: GatewayRelayError['code']) => {
  expect(Exit.isFailure(result)).toBe(true);
  if (Exit.isFailure(result)) {
    const failure = Cause.squash(result.cause);
    expect(Schema.is(GatewayRelayError)(failure)).toBe(true);
    if (Schema.is(GatewayRelayError)(failure)) {
      expect(failure.code).toBe(code);
    }
  }
};

const assertForbidden = (result: Exit.Exit<void, unknown>) => assertRejected(result, 'forbidden');

const sessionPrincipal = Schema.decodeUnknownSync(GatewayTrustedPrincipalContextSchema)({
  ...relayUnitPrincipal,
  authContextRef: 'better-auth-session:current-session',
  authMethod: 'session',
});

it.effect('accepts current controlled key and ordinary session through real Auth SQL and validation', () =>
  Effect.gen(function* validAuth() {
    const key = yield* authenticate(relayUnitPrincipal, [[[true, null]]]);
    expect(Exit.isSuccess(key.result)).toBe(true);
    expect(key.queries).toHaveLength(1);
    const session = yield* authenticate(sessionPrincipal, [[Object.values(unitSession)]]);
    expect(Exit.isSuccess(session.result)).toBe(true);
    expect(session.queries).toHaveLength(1);
  }),
);

for (const reference of [undefined, 'foreign:original-key', 'better-auth-session:current-session']) {
  it.effect(`rejects unsupported API-key authentication reference ${reference ?? 'missing'} before SQL`, () =>
    Effect.gen(function* invalidReference() {
      const { authContextRef: _reference, ...withoutReference } = relayUnitPrincipal;
      const principal = reference === undefined ? withoutReference : { ...withoutReference, authContextRef: reference };
      const result = yield* authenticate(principal, []);
      assertForbidden(result.result);
      expect(result.queries).toHaveLength(0);
    }),
  );
}

for (const [label, rows] of [
  ['missing', []],
  ['disabled', [[false, null]]],
  ['expired', [[true, new Date(relayUnitNow * 1000)]]],
] satisfies readonly (readonly [string, readonly (readonly unknown[])[]])[]) {
  it.effect(`rejects the ${label} original provider key`, () =>
    Effect.gen(function* invalidKey() {
      assertForbidden((yield* authenticate(relayUnitPrincipal, [rows])).result);
    }),
  );
}

for (const identity of [
  { ...relayUnitIdentity, principalId: '40000000-0000-4000-8000-000000000002' },
  { ...relayUnitIdentity, tenantId: '50000000-0000-4000-8000-000000000002' },
  { ...relayUnitIdentity, authBindingId: '10000000-0000-4000-8000-000000000002' },
]) {
  it.effect(
    `rejects changed original identity ${identity.principalId}/${identity.tenantId}/${identity.authBindingId}`,
    () =>
      Effect.gen(function* changedIdentity() {
        assertForbidden(
          (yield* authenticate(relayUnitPrincipal, [[[true, null]]], {
            resolveBetterAuthApiKey: () => Effect.succeed(identity),
          })).result,
        );
      }),
  );
}

it.effect('rejects a revoked original Core binding independently of an enabled provider key', () =>
  Effect.gen(function* revokedBinding() {
    assertForbidden(
      (yield* authenticate(relayUnitPrincipal, [[[true, null]]], {
        resolveBetterAuthApiKey: () => Effect.fail(new PrincipalBindingMissingError()),
      })).result,
    );
  }),
);

const sessionChanges: readonly (readonly [string, Partial<typeof unitSession>])[] = [
  ['expired', { expiresAt: new Date(relayUnitNow * 1000) }],
  ['changed-tenant', { activeTenantId: '50000000-0000-4000-8000-000000000002' }],
  ['changed-legal-entity', { activeLegalEntityId: '30000000-0000-4000-8000-000000000002' }],
  ['permanently-banned', { banned: true }],
  ['temporarily-banned', { banExpires: new Date((relayUnitNow + 60) * 1000), banned: true }],
  ['unexpected-impersonation', { impersonatedBy: 'support-user' }],
];
for (const [label, change] of sessionChanges) {
  it.effect(`rejects ${label} original session`, () =>
    Effect.gen(function* invalidSession() {
      assertForbidden((yield* authenticate(sessionPrincipal, [[Object.values({ ...unitSession, ...change })]])).result);
    }),
  );
}

it.effect('rejects a deleted session and changed session identity binding', () =>
  Effect.gen(function* missingSession() {
    assertForbidden((yield* authenticate(sessionPrincipal, [[]])).result);
    assertForbidden(
      (yield* authenticate(sessionPrincipal, [[Object.values(unitSession)]], {
        resolveBetterAuthUserForTenant: () =>
          Effect.succeed({ ...relayUnitIdentity, authBindingId: '10000000-0000-4000-8000-000000000002' }),
      })).result,
    );
  }),
);

const supportId = '60000000-0000-4000-8000-000000000001';
const supportBinding = '70000000-0000-4000-8000-000000000001';
const impersonated = Schema.decodeUnknownSync(GatewayTrustedPrincipalContextSchema)({
  ...sessionPrincipal,
  authMethod: 'support_impersonation',
  impersonatedByPrincipalId: supportId,
});
const supportSession = {
  ...unitSession,
  actionId: 'support-action',
  impersonatedBy: 'support-user',
  originalAuthBindingId: supportBinding,
  originalPrincipalId: supportId,
  originalSessionId: 'support-session',
  reason: 'Controlled support evidence',
  targetPrincipalId: relayUnitIdentity.principalId,
};
const originalSession = {
  banExpires: null,
  banned: false,
  expiresAt: new Date((relayUnitNow + 60) * 1000),
  userId: 'support-user',
};
const supportResolver = makePrincipalResolverDouble({
  resolveBetterAuthUserForTenant: (id) =>
    Effect.succeed(
      id === 'support-user'
        ? { ...relayUnitIdentity, authBindingId: supportBinding, principalId: supportId }
        : relayUnitIdentity,
    ),
  verifySupportImpersonationStarted: () => Effect.succeed(true),
});
it.effect('checks both real session queries and started evidence for controlled support impersonation', () =>
  Effect.gen(function* validSupport() {
    const checked = yield* authenticate(
      impersonated,
      [[Object.values(supportSession)], [Object.values(originalSession)]],
      supportResolver,
    );
    expect(Exit.isSuccess(checked.result)).toBe(true);
    expect(checked.queries).toHaveLength(2);
  }),
);
for (const [label, change] of [
  ['missing-original-session', { originalSessionId: null }],
  ['missing-reason', { reason: null }],
  ['changed-target', { targetPrincipalId: supportId }],
] satisfies readonly (readonly [string, Partial<typeof unitSession>])[]) {
  it.effect(`rejects support lineage ${label}`, () =>
    Effect.gen(function* invalidSupport() {
      assertForbidden(
        (yield* authenticate(impersonated, [[Object.values({ ...supportSession, ...change })]], supportResolver))
          .result,
      );
    }),
  );
}
it.effect('rejects ended impersonator sessions and missing canonical started evidence', () =>
  Effect.gen(function* endedSupport() {
    assertForbidden(
      (yield* authenticate(
        impersonated,
        [
          [Object.values(supportSession)],
          [Object.values({ ...originalSession, expiresAt: new Date(relayUnitNow * 1000) })],
        ],
        supportResolver,
      )).result,
    );
    assertForbidden(
      (yield* authenticate(impersonated, [[Object.values(supportSession)], [Object.values(originalSession)]], {
        ...supportResolver,
        verifySupportImpersonationStarted: () => Effect.succeed(false),
      })).result,
    );
  }),
);

it.effect(
  'preserves unavailable Auth SQL and Principal resolver outcomes instead of permitting or misclassifying denial',
  () =>
    Effect.gen(function* unavailableAuth() {
      assertRejected((yield* authenticate(relayUnitPrincipal, [], {}, true)).result, 'unavailable');
      assertRejected(
        (yield* authenticate(relayUnitPrincipal, [[[true, null]]], {
          resolveBetterAuthApiKey: () =>
            Effect.fail(new PrincipalResolverUnavailableError({ reason: 'Controlled resolver unavailable' })),
        })).result,
        'unavailable',
      );
      assertRejected(
        (yield* authenticate(sessionPrincipal, [[Object.values(unitSession)]], {
          resolveBetterAuthUserForTenant: () =>
            Effect.fail(new PrincipalResolverUnavailableError({ reason: 'Controlled session resolver unavailable' })),
        })).result,
        'unavailable',
      );
    }),
);
