import { expect, test } from '@rstest/core';
import { TenantModuleStateReadUnavailableError, TenantModuleStateService } from '@app/core-runtime';
import type { TenantModuleStateServiceShape } from '@app/core-runtime';
import { Effect, Layer } from 'effect';
import type { GatewayIssuerDependencies } from '../../api/auth/gateway-issuer.ts';
import {
  AuthenticationInternalError,
  AuthenticationUnavailableError,
  OntosIdentityForbiddenError,
} from '../../api/auth/errors.ts';
import { AuthenticationService } from '../../api/auth/service.ts';
import type { AuthenticationServiceShape } from '../../api/auth/service.ts';
import { makeShellAuthenticationApiRuntime } from '../../api/index.ts';
import { InstalledVerticalTopologyError } from '../../api/verticals/installed-verticals.ts';

const identity = {
  displayName: 'Ada Lovelace',
  email: 'ada@example.test',
  principalId: 'principal-safe',
  tenantId: 'tenant-safe',
};

const unusedIssuerDependencies: GatewayIssuerDependencies = {
  currentTimeSeconds: Effect.succeed(1_700_000_000),
  generateJti: Effect.succeed('unused'),
  loadAudiences: Effect.succeed(new Set(['testing1'])),
  loadConfig: Effect.die(new Error('unused issuer configuration')),
};

const makeAuthentication = (
  currentSession: AuthenticationServiceShape['currentSession'],
): AuthenticationServiceShape => ({
  createFixtureUser: () => Effect.die(new Error('unused createFixtureUser')),
  currentSession,
  signIn: () => Effect.die(new Error('unused signIn')),
  signOut: () => Effect.die(new Error('unused signOut')),
});

const requestActiveModules = async (
  authentication: AuthenticationServiceShape,
  listActiveTenantModules: TenantModuleStateServiceShape['listActiveTenantModules'],
  installed = Effect.succeed<ReadonlySet<string>>(new Set(['testing1', 'future-generated'])),
) => {
  const runtime = makeShellAuthenticationApiRuntime(
    Layer.succeed(AuthenticationService, authentication),
    unusedIssuerDependencies,
    Layer.succeed(TenantModuleStateService, { listActiveTenantModules }),
    installed,
  );
  const handler = runtime.createHandler();
  try {
    return await handler.handler(
      new Request('https://shell.example.test/modules/active', {
        headers: { cookie: 'session=test-session', 'x-correlation-id': 'runtime-test' },
      }),
    );
  } finally {
    await handler.dispose();
  }
};

test.sequential('revalidates the session, forwards cookies, filters installed IDs, and sorts the result', async () => {
  let trustedTenant = '';
  const response = await requestActiveModules(
    makeAuthentication(() =>
      Effect.succeed({
        identity,
        setCookieHeaders: ['refreshed-session=value; Path=/; HttpOnly'],
      }),
    ),
    (tenantId) => {
      trustedTenant = tenantId;
      return Effect.succeed([
        { moduleKey: 'testing1', state: 'active' },
        { moduleKey: 'stale-non-installed', state: 'active' },
        { moduleKey: 'future-generated', state: 'active' },
      ]);
    },
  );

  expect(response.status).toBe(200);
  expect(trustedTenant).toBe(identity.tenantId);
  expect(await response.json()).toEqual([
    { moduleKey: 'future-generated', state: 'active' },
    { moduleKey: 'testing1', state: 'active' },
  ]);
});

test.sequential('returns a declared Bearer 401 for anonymous and forbidden sessions', async () => {
  const responses = await Promise.all([
    requestActiveModules(
      makeAuthentication(() => Effect.succeed({ identity: null, setCookieHeaders: [] })),
      () => Effect.succeed([]),
    ),
    requestActiveModules(
      makeAuthentication(() => Effect.fail(new OntosIdentityForbiddenError())),
      () => Effect.succeed([]),
    ),
  ]);
  const bodies = await Promise.all(responses.map((response) => response.json()));

  for (const [index, response] of responses.entries()) {
    expect(response.status).toBe(401);
    expect(bodies[index]?._tag).toBe('ActiveModulesAuthenticationRequiredProblem');
  }
});

test.sequential('maps authentication and Core availability failures to one sanitized retryable 503', async () => {
  const responses = await Promise.all([
    requestActiveModules(
      makeAuthentication(() => Effect.fail(new AuthenticationUnavailableError())),
      () => Effect.succeed([]),
    ),
    requestActiveModules(
      makeAuthentication(() => Effect.succeed({ identity, setCookieHeaders: [] })),
      () =>
        Effect.fail(
          new TenantModuleStateReadUnavailableError({
            code: 'tenant_module_state_read_unavailable',
            reason: 'secret SQL detail for tenant-safe',
          }),
        ),
    ),
  ]);
  const bodies = await Promise.all(responses.map((response) => response.json()));

  for (const [index, response] of responses.entries()) {
    expect(response.status).toBe(503);
    const body = bodies[index] as { readonly _tag?: string; readonly retryable?: boolean };
    expect(body._tag).toBe('ActiveModulesUnavailableProblem');
    expect(body.retryable).toBe(true);
    expect(JSON.stringify(body)).not.toMatch(/SQL|tenant-safe|principal-safe/u);
  }
});

test.sequential('sanitizes internal authentication, topology, and unexpected service defects as declared 500s', async () => {
  const responses = await Promise.all([
    requestActiveModules(
      makeAuthentication(() => Effect.fail(new AuthenticationInternalError())),
      () => Effect.succeed([]),
    ),
    requestActiveModules(
      makeAuthentication(() => Effect.succeed({ identity, setCookieHeaders: [] })),
      () => Effect.succeed([]),
      Effect.fail(
        new InstalledVerticalTopologyError({ reason: 'secret topology path /internal/file' }),
      ),
    ),
    requestActiveModules(
      makeAuthentication(() => Effect.succeed({ identity, setCookieHeaders: [] })),
      () => Effect.die(new Error('secret database defect for tenant-safe')),
    ),
  ]);
  const bodies = await Promise.all(responses.map((response) => response.json()));

  for (const [index, response] of responses.entries()) {
    expect(response.status).toBe(500);
    const body = bodies[index] as { readonly _tag?: string };
    expect(body._tag).toBe('ActiveModulesInternalProblem');
    expect(JSON.stringify(body)).not.toMatch(/secret|internal\/file|tenant-safe|principal-safe/u);
  }
});
