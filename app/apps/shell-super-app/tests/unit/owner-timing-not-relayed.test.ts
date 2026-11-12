// @rstest-environment node
/*
 * A module owner reports its gate, SpiceDB and SQL timings in `server-timing`. The Shell reads them for its own log
 * line and relays them to nobody: one test per client path, each from an owner response carrying such a header to
 * the response that leaves the Shell.
 */
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { TrustedPrincipalContext } from '@app/core-runtime';
import { ActiveApplicationCompositionService } from '@app/core-runtime/modules/active-application-composition';
import { Context, Crypto, Effect, FiberSet, Layer, Option, Ref } from 'effect';
import { HttpEffect, HttpRouter, HttpServerRequest, HttpServerResponse } from 'effect/http';
import { describe, expect, it, rs } from 'effect-rstest';

import { callModuleAs } from '../../api/agent-platform/module-call.ts';
import { AgentReadRequestIdentity } from '../../api/auth/agent-request-identity.ts';
import { GatewayIssuer, ShellCryptoLive } from '../../api/auth/gateway-issuer.ts';
import { GatewayTimings, gatewayTimingCollector, observeGatewayPhase } from '../../api/auth/gateway-timing.ts';
import { serveMcp } from '../../api/mcp/http.ts';
import type { McpConnectionTools, McpEndpointConfig } from '../../api/mcp/http.ts';
import { buildConnectionTools } from '../../api/mcp/tools.ts';
import type { McpBackend } from '../../api/mcp/types.ts';
import { ModuleUnavailable } from '../../api/mcp/module-unavailable.ts';
import { ShellInstalledModuleCatalog } from '../../api/modules/installed-module-catalog.ts';
import { dispatchModuleApiRequest, ModuleApiTransportLive } from '../../src/module-api/transport.ts';
import { makeCompositionSnapshot } from '../fixtures/application-composition.ts';
import { connectionDescription, fixtureCatalog } from './mcp/fixture-vertical.ts';

const OWNER_TIMING = 'owner-total;dur=40, owner-gate;dur=12';

const owner = rs.hoisted(() => ({ calls: 0 }));

rs.mock('../../src/module-api/admission.ts', () => ({
  admitModuleApiRequest: (request: Request) =>
    Effect.succeed({
      forwardedRequest: request,
      module: { deployment: { appId: 'fixture-notes' } },
      responseCookieNames: [],
    }),
}));
rs.mock('@app/core-runtime/unit-service-fetch', () => ({
  moduleReleaseFetch: () =>
    Effect.sync(() => {
      owner.calls += 1;
      return Response.json(
        { canWrite: true, notes: [{ text: 'první' }], revision: 7 },
        { headers: { 'server-timing': OWNER_TIMING } },
      );
    }),
}));

// As the Shell API root wraps each gateway request.
const withGatewayTimings = <Value, Failure, Requirements>(effect: Effect.Effect<Value, Failure, Requirements>) =>
  Effect.gen(function* provideRequestTimings() {
    const collector = yield* gatewayTimingCollector;
    yield* collector.appendResponseHeader;
    return yield* effect.pipe(Effect.provideService(GatewayTimings, Option.some(collector.timings)));
  });

/** No owner phase name may appear in what leaves the Shell. */
const expectNoOwnerTiming = (header: string | null | undefined) => {
  for (const name of ['owner-total', 'owner-gate']) {
    expect(header ?? '').not.toContain(name);
  }
};

const composition = Layer.effect(
  ActiveApplicationCompositionService,
  makeCompositionSnapshot([]).pipe(Effect.map((snapshot) => ({ load: Effect.succeed(snapshot) }))),
);

describe('an owner server-timing never leaves the Shell', () => {
  it.effect('browser: the /module-api relay route answers without it', () =>
    Effect.gen(function* browserPath() {
      owner.calls = 0;
      const route = yield* Effect.acquireRelease(
        Effect.sync(() =>
          HttpRouter.toWebHandler(ModuleApiTransportLive.pipe(Layer.provide(composition)), { disableLogger: true }),
        ),
        (handler) => Effect.promise(() => handler.dispose()),
      );
      const response = yield* Effect.promise(() =>
        route.handler(
          new Request('https://shell.test/module-api/fixture-notes/build/fixture-notes-api/reads/records', {
            body: '{}',
            method: 'POST',
          }),
          Context.empty(),
        ),
      );
      expect(owner.calls).toBe(1);
      expect(response.status).toBe(200);
      expect(response.headers.get('server-timing')).toBeNull();
      expect(yield* Effect.promise(() => response.json())).toEqual({
        canWrite: true,
        notes: [{ text: 'první' }],
        revision: 7,
      });
    }).pipe(Effect.scoped),
  );

  it.effect('storefront: the API-key gateway read sends only the gateway phases', () =>
    Effect.gen(function* storefrontPath() {
      owner.calls = 0;
      const sent = yield* Ref.make(HttpServerResponse.empty());
      // The tail of the gateway read handler: in-process owner dispatch, its phase, and the gateway's timing header.
      const gatewayRead = dispatchModuleApiRequest(
        new Request('https://shell.invalid/module-api/fixture-notes/build/fixture-notes-api/reads/records', {
          body: '{}',
          method: 'POST',
        }),
      ).pipe(observeGatewayPhase('owner-dispatch'), Effect.map(HttpServerResponse.fromWeb), withGatewayTimings);
      yield* HttpEffect.toHandled(gatewayRead, (_request, response) => Ref.set(sent, response)).pipe(
        Effect.provideService(
          HttpServerRequest.HttpServerRequest,
          HttpServerRequest.fromWeb(new Request('https://shell.test/shell-super-app-api/auth/api-key/gateway-read')),
        ),
        Effect.provide(composition),
      );
      const response = HttpServerResponse.toWeb(yield* Ref.get(sent));
      expect(owner.calls).toBe(1);
      expect(response.status).toBe(200);
      expect(response.headers.get('server-timing')).toBe('owner-dispatch;dur=0');
      expectNoOwnerTiming(response.headers.get('server-timing'));
    }),
  );

  it.effect('MCP: a tool call that reads an owner answers the MCP client without it', () =>
    Effect.gen(function* mcpPath() {
      owner.calls = 0;
      const crypto = yield* Effect.service(Crypto.Crypto).pipe(Effect.provide(ShellCryptoLive));
      const snapshot = yield* makeCompositionSnapshot([]);
      const principal: TrustedPrincipalContext = {
        authBindingId: '00000000-0000-4000-8000-000000000004',
        authContextRef: 'session:owner-timing',
        authMethod: 'session',
        legalEntityId: '00000000-0000-4000-8000-000000000002',
        principalId: '00000000-0000-4000-8000-000000000003',
        tenantId: '00000000-0000-4000-8000-000000000001',
      };
      const services = Layer.mergeAll(
        Layer.succeed(ActiveApplicationCompositionService, { load: Effect.succeed(snapshot) }),
        Layer.succeed(AgentReadRequestIdentity, { correlationId: 'owner-timing' }),
        Layer.mock(GatewayIssuer, {
          issue: () =>
            Effect.succeed({
              apiBaseUrl: '/fixture-api',
              compositionRevision: snapshot.composition.revision,
              expiresAt: 0,
              token: 't',
            }),
        }),
        Layer.mock(ShellInstalledModuleCatalog, {}),
      );
      // The real module call of an MCP tool; only the proposal queue is out of this path.
      const backend: McpBackend = {
        callModule: (appId, path, body, options) =>
          callModuleAs(principal, appId, path, body, options).pipe(
            Effect.provide(services),
            Effect.mapError((cause) => new ModuleUnavailable({ cause, message: 'Modul teď neodpovídá.' })),
          ),
        listProposals: Effect.die('not on this path'),
        submitProposals: () => Effect.die('not on this path'),
      };
      const description = connectionDescription();
      const config: McpEndpointConfig = {
        issuer: 'http://localhost:3020/shell-super-app-api/oauth',
        prmUrl: 'http://localhost:3020/.well-known/oauth-protected-resource/mcp',
        publicOrigin: 'http://localhost:3020',
        resource: 'http://localhost:3020/mcp',
      };
      const handler = serveMcp({
        authenticate: () =>
          Effect.succeed({
            clientId: description.client.clientId,
            grantId: description.grantId,
            kind: 'ok' as const,
            tools: Effect.succeed<McpConnectionTools>({
              kind: 'ok',
              tools: buildConnectionTools({
                backend,
                catalog: fixtureCatalog(),
                crypto,
                description,
                prmUrl: config.prmUrl,
                publicOrigin: config.publicOrigin,
              }),
            }),
          }),
        config: Effect.succeed(config),
      });
      const timings: (string | null)[] = [];
      const run = yield* FiberSet.makeRuntimePromise();
      const client = yield* Effect.acquireRelease(
        Effect.sync(
          () =>
            new Client(
              { name: 'ontos-test', version: '1.0.0' },
              { versionNegotiation: { mode: { pin: '2026-07-28' } } },
            ),
        ),
        (ownedClient) => Effect.promise(() => ownedClient.close()),
      );
      yield* Effect.promise(() =>
        client.connect(
          new StreamableHTTPClientTransport(new URL(config.resource), {
            fetch: (input, init) => {
              const request = new Request(input, init);
              request.headers.set('authorization', 'Bearer good');
              return run(handler(request), { signal: request.signal }).then((response) => {
                timings.push(response.headers.get('server-timing'));
                return response;
              });
            },
          }),
        ),
      );
      const result = yield* Effect.promise(() =>
        client.callTool({ arguments: {}, name: 'fixture_notes__read_records' }),
      );
      expect(result.isError).not.toBe(true);
      expect(owner.calls).toBe(1);
      expect(timings.length).toBeGreaterThan(0);
      expect(timings.every((timing) => timing === null)).toBe(true);
      const text = JSON.stringify(result);
      expect(text).toContain('první');
      expectNoOwnerTiming(text);
    }).pipe(Effect.scoped),
  );
});
