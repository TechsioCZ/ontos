// @effect-diagnostics asyncFunction:off
import { expect, rstest, test } from '@rstest/core';
import { HttpApiBuilder } from '@modern-js/plugin-bff/effect-edge';
import { Effect, Layer, Redacted } from 'effect';
import * as jose from 'jose';
import { makeShellAuthenticationApiRuntime } from '../../api/index.ts';
import { AuthenticationService } from '../../api/auth/service.ts';
import type { ShellContextResult } from '../../api/auth/service.ts';
import type { GatewayIssuerDependencies } from '../../api/auth/gateway-issuer.ts';
import * as governedReads from '../../api/modules/shell-governed-reads.ts';
import type { ShellResourceContext } from '../../api/modules/shell-resources.ts';

import * as actualJose from 'jose' with { rstest: 'importActual' };

rstest.mock('jose', () => ({ ...actualJose, importJWK: rstest.fn(actualJose.importJWK) }));

const principal = {
  authBindingId: '10000000-0000-4000-8000-000000000001',
  authContextRef: 'better-auth-session:issuer-lifetime-test',
  authMethod: 'session' as const,
  principalId: '40000000-0000-4000-8000-000000000001',
  tenantId: '50000000-0000-4000-8000-000000000001',
};
const context: ShellResourceContext = { ...principal, correlationId: 'issuer-lifetime-test' };
type GatewayHandler = (input: {
  payload: { audience: string };
  request: { headers: Record<string, string> };
}) => Effect.Effect<{ token: string }, unknown, AuthenticationService>;
type CapturedHandlers = {
  handle: (name: string, handler: GatewayHandler) => CapturedHandlers;
};

test('shares signing import across runtime gateway/provider assertions, but not across runtimes', async () => {
  // Capture handlers and provider wiring without building persistence or connecting to a database.
  const gatewayHandlers: GatewayHandler[] = [];
  const originalGroup = HttpApiBuilder.group;
  const captureGroup: typeof HttpApiBuilder.group = (api, name, build) => {
    if (name === 'gatewayContext') {
      const handlers: CapturedHandlers = {
        handle: (endpoint, handler) => {
          if (endpoint === 'issueGatewayContext') gatewayHandlers.push(handler);
          return handlers;
        },
      };
      (build as unknown as (handlers: CapturedHandlers) => unknown)(handlers);
    }
    return originalGroup(api, name, build);
  };
  rstest.spyOn(HttpApiBuilder, 'group').mockImplementation(captureGroup);
  const reads = rstest.spyOn(governedReads, 'createShellGovernedReadsLayer');
  const importKey = rstest.mocked(jose.importJWK);
  const { privateKey } = await jose.generateKeyPair('EdDSA', { extractable: true });
  const jwk = await jose.exportJWK(privateKey);
  const loadConfig = rstest.fn(() => ({
    issuer: 'https://shell.example.test',
    privateJwk: {
      alg: 'EdDSA' as const,
      crv: 'Ed25519' as const,
      d: jwk.d ?? '',
      kid: 'runtime-test',
      kty: 'OKP' as const,
      use: 'sig' as const,
      x: jwk.x ?? '',
    },
  }));
  let jti = 0;
  const dependencies: GatewayIssuerDependencies = {
    currentTimeSeconds: Effect.succeed(1_700_000_000),
    generateJti: Effect.sync(() => `assertion-${++jti}`),
    loadAudiences: Effect.succeed(new Set(['property-registry'])),
    loadConfig: Effect.sync(loadConfig),
  };
  const unused = () => Effect.die('Unexpected authentication operation');
  const authentication = Layer.succeed(AuthenticationService, {
    availableTenants: unused,
    createFixtureUser: unused,
    currentSession: unused,
    resolveShellContext: () =>
      Effect.succeed({
        principal,
        setCookieHeaders: [],
        state: 'authenticated',
      } as unknown as ShellContextResult),
    resolveTenantContext: unused,
    signIn: unused,
    signOut: unused,
    switchLegalEntity: unused,
    switchTenant: unused,
  });
  makeShellAuthenticationApiRuntime(authentication, dependencies);
  makeShellAuthenticationApiRuntime(authentication, dependencies);
  expect(reads).toHaveBeenCalledTimes(2);
  expect(gatewayHandlers).toHaveLength(2);
  expect(importKey).not.toHaveBeenCalled();
  const gateway = async (runtime: number) => {
    const handler = gatewayHandlers[runtime];
    if (!handler) throw new Error('Missing gateway handler');
    return (
      await Effect.runPromise(
        handler({
          payload: { audience: 'property-registry' },
          request: { headers: {} },
        }).pipe(Effect.provide(authentication)),
      )
    ).token;
  };
  const provider = async (runtime: number) => {
    const issuer = reads.mock.calls[runtime]?.[1];
    if (!issuer) throw new Error('Missing provider issuer');
    const assertion = await Effect.runPromise(
      issuer.issueAssertion({ appId: 'property-registry', context }),
    );
    expect(Redacted.isRedacted(assertion)).toBe(true);
    return Redacted.value(assertion).replace(/^Bearer /u, '');
  };
  const tokens = await Promise.all([gateway(0), provider(0), gateway(0), provider(0)]);
  tokens.push(await gateway(0), await provider(0));
  expect(importKey).toHaveBeenCalledTimes(1);
  expect(loadConfig).toHaveBeenCalledTimes(1);
  tokens.push(...(await Promise.all([gateway(1), provider(1)])));
  expect(importKey).toHaveBeenCalledTimes(2);
  expect(loadConfig).toHaveBeenCalledTimes(2);
  tokens.push(await provider(0));
  expect(importKey).toHaveBeenCalledTimes(2);
  expect(new Set(tokens.map((token) => jose.decodeJwt(token).jti)).size).toBe(tokens.length);
});
