import { randomUUID } from 'node:crypto';
import { AccessDecisionGate } from '@app/core-runtime/access/enforcement';
import type { NodeServices } from '@effect/platform-node';
import { ConfigProvider, Effect, Layer } from 'effect';
import { expect, it } from 'effect-rstest';

import { AuthConfig } from '../../apps/shell-super-app/api/auth/config.ts';
import { AuthenticationService } from '../../apps/shell-super-app/api/auth/service.ts';
import type { AgentProfileOperatorLive } from './agent-profile-operator.mts';
import { authenticateAgentProfileOperator } from './agent-profile-operator.mts';

// Each executable already provides NodeServices at Command.run. All remaining services belong in the operator root.
type UnprovidedOperatorServices = Exclude<
  Layer.Services<typeof AgentProfileOperatorLive>,
  Layer.Success<typeof NodeServices.layer>
>;
const operatorDependenciesAreComplete: [UnprovidedOperatorServices] extends [never] ? true : false = true;

it('the shared admin runtime and CLI Node services provide every required service', () => {
  expect(operatorDependenciesAreComplete).toBe(true);
});

const identity = {
  displayName: 'Reviewed operator',
  email: 'operator@example.test',
  principalId: '10000000-0000-4000-8000-000000000001',
  tenantId: '20000000-0000-4000-8000-000000000001',
};
const principal = {
  authBindingId: '30000000-0000-4000-8000-000000000001',
  authContextRef: 'session:operator-cookie-test',
  authenticationNamespaceId: 'test.staff',
  authMethod: 'session' as const,
  principalId: identity.principalId,
  tenantId: identity.tenantId,
};
const configuration = Layer.mergeAll(
  ConfigProvider.layer(
    ConfigProvider.fromUnknown({
      ONTOS_AGENT_SETUP_EMAIL: identity.email,
      ONTOS_AGENT_SETUP_PASSWORD: randomUUID(),
    }),
  ),
  Layer.succeed(AuthConfig, {
    baseUrl: 'https://shell.example.test',
    connectionString: 'postgresql://test.invalid/unit',
    secret: randomUUID(),
    secureCookies: true,
    supportUserIds: [],
    trustedOrigins: ['https://shell.example.test'],
  }),
  Layer.succeed(AccessDecisionGate, {
    decide: () => Effect.die('Unexpected access decision in the session transport fixture'),
    decideMany: () => Effect.die('Unexpected bulk access decision in the session transport fixture'),
    list: () => Effect.die('Unexpected list access in the session transport fixture'),
    listMany: () => Effect.die('Unexpected bulk list access in the session transport fixture'),
    selectableLegalEntities: () => Effect.die('Unexpected company selection in the session transport fixture'),
  }),
);

it.effect('retains native tenant-context cookie rotation for the next operation and sign-out', () =>
  Effect.gen(function* retainedTenantSession() {
    const signOutCookies: (string | null)[] = [];
    const session = yield* authenticateAgentProfileOperator.pipe(
      Effect.provide(
        Layer.mock(AuthenticationService, {
          resolveTenantContext: (headers) => {
            expect(headers.get('cookie')).toBe('session=first');
            return Effect.succeed({
              identity,
              principal,
              setCookieHeaders: ['session=rotated; Path=/; Secure; HttpOnly'],
              state: 'authenticated' as const,
            });
          },
          signIn: () => Effect.succeed({ identity, setCookieHeaders: ['session=first; Path=/; Secure; HttpOnly'] }),
          signOut: (headers) =>
            Effect.sync(() => {
              signOutCookies.push(headers.get('cookie'));
              return { setCookieHeaders: [] };
            }),
        }),
      ),
      Effect.provide(configuration),
    );
    expect(session.requestHeaders.get('cookie')).toBe('session=rotated');
    expect(signOutCookies).toEqual([]);
    yield* session.close;
    expect(signOutCookies).toEqual(['session=rotated']);
  }),
);

it.effect('closes an acquired login when tenant resolution refuses admission', () =>
  Effect.gen(function* refusedTenantSession() {
    const signOutCookies: (string | null)[] = [];
    const failure = yield* authenticateAgentProfileOperator.pipe(
      Effect.provide(
        Layer.mock(AuthenticationService, {
          resolveTenantContext: () =>
            Effect.succeed({ setCookieHeaders: ['session=refused; Path=/; HttpOnly'], state: 'anonymous' as const }),
          signIn: () => Effect.succeed({ identity, setCookieHeaders: ['session=first; Path=/; HttpOnly'] }),
          signOut: (headers) =>
            Effect.sync(() => {
              signOutCookies.push(headers.get('cookie'));
              return { setCookieHeaders: [] };
            }),
        }),
      ),
      Effect.provide(configuration),
      Effect.flip,
    );
    expect(failure).toMatchObject({ _tag: 'AgentProfileSetupError' });
    expect(signOutCookies).toEqual(['session=refused']);
  }),
);
