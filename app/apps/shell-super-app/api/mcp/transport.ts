/**
 * Mounts the MCP endpoint on the Shell BFF (`/shell-super-app-api/mcp` and `/shell-super-app-api/mcp-resource-metadata`;
 * the root `/mcp` and `/.well-known/oauth-protected-resource[/mcp]` reach them through `rootRouteTarget`).
 * Every tool call runs in-process as the connection's principal: a fresh gateway assertion for the owning vertical,
 * dispatched to its BFF (service binding on Workers, its URL on Node), and proposals through the platform queue.
 */
import { Crypto, Effect, Layer, Predicate } from 'effect';
import { HttpRouter, HttpServerRequest, HttpServerResponse } from 'effect/unstable/http';

import { MCP_BFF_ROUTE, MCP_METADATA_BFF_ROUTE, mcpMetadataUrlOf } from '../../shared/mcp-resource.ts';
import type { AgentPlatformCaller } from '../agent-platform/caller.ts';
import { callModuleAs } from '../agent-platform/module-call.ts';
import { listOwnAgentBatches, submitAgentProposals } from '../agent-platform/service-queue.ts';
import { ShellInstalledModuleCatalog } from '../modules/installed-module-catalog.ts';
import { loadOAuthServerConfig } from '../oauth-connections/server-config.ts';
import { loadMcpCatalog } from './catalog.ts';
import { authenticateMcpRequest, connectionPrincipalContext } from './connection.ts';
import { serveMcp, serveMcpMetadata } from './http.ts';
import type { McpAuthentication, McpEndpointConfig } from './http.ts';
import { buildConnectionTools } from './tools.ts';
import type { McpBackend } from './types.ts';
import { ModuleUnavailable, ProposalRefused } from './types.ts';

const describeConnection = (token: string) =>
  Effect.gen(function* describeConnectionEffect() {
    const live = yield* authenticateMcpRequest(token);
    const installed = yield* (yield* ShellInstalledModuleCatalog).load;
    return { catalog: yield* loadMcpCatalog(installed.composition), live };
  });

/** The services the tools' backend calls borrow from the request being served. */
type McpBackendServices =
  | Effect.Services<ReturnType<typeof callModuleAs>>
  | Effect.Services<ReturnType<typeof listOwnAgentBatches>>
  | Effect.Services<ReturnType<typeof submitAgentProposals>>;

const QUEUE_UNAVAILABLE = 'Fronta návrhů teď není dostupná. Zkuste to za chvíli.';

const reasonOf = (error: unknown, fallback: string): string => {
  const reason: unknown = Predicate.isObject(error) ? Reflect.get(error, 'reason') : undefined;
  return typeof reason === 'string' ? reason : fallback;
};

const endpointConfig = loadOAuthServerConfig.pipe(
  Effect.map(({ issuer, resource }): McpEndpointConfig => ({
    issuer,
    prmUrl: mcpMetadataUrlOf(resource),
    publicOrigin: new URL(resource).origin,
    resource,
  })),
);

const authenticate = Effect.fn('Mcp.authenticateRequest')(function* authenticateRequest(token: string) {
  const outcome = yield* describeConnection(token).pipe(
    Effect.map((value) => ({ _tag: 'ok' as const, ...value })),
    Effect.catch((error) =>
      Effect.succeed({
        _tag: Predicate.isTagged(error, 'ConnectionUnauthorized') ? ('invalid' as const) : ('unavailable' as const),
      }),
    ),
    Effect.catchDefect((defect) =>
      Effect.logError('MCP authentication defect', defect).pipe(Effect.as({ _tag: 'unavailable' as const })),
    ),
  );
  if (outcome._tag !== 'ok') {
    return { kind: outcome._tag } satisfies McpAuthentication;
  }
  const { catalog, live } = outcome;
  const principal = connectionPrincipalContext(live);
  const caller: AgentPlatformCaller = { legalName: live.description.legalName, principal };
  const endpoint = yield* endpointConfig;
  const crypto = yield* Crypto.Crypto;
  // Tool calls run later, from the SDK's callbacks, with the services of this same request.
  const services = yield* Effect.context<McpBackendServices>();
  const backend: McpBackend = {
    callModule: (appId, path, body, options) =>
      callModuleAs(principal, appId, path, body, {
        ...(options.idempotencyKey === undefined ? {} : { idempotencyKey: options.idempotencyKey }),
        ...(options.referenceAudiences === undefined ? {} : { referenceAudiences: options.referenceAudiences }),
      }).pipe(
        Effect.mapError((error) => new ModuleUnavailable({ message: error.reason })),
        Effect.provideContext(services),
      ),
    listProposals: listOwnAgentBatches(caller).pipe(
        Effect.mapError(() => new ModuleUnavailable({ message: QUEUE_UNAVAILABLE })),
        Effect.provideContext(services),
      ),
    submitProposals: (request) =>
      submitAgentProposals(caller, request).pipe(
        Effect.mapError((error) =>
          Predicate.isTagged(error, 'AgentPlatformInvalid') || Predicate.isTagged(error, 'AgentPlatformForbidden')
            ? new ProposalRefused({ message: reasonOf(error, 'Návrh nebyl přijat.') })
            : new ModuleUnavailable({ message: QUEUE_UNAVAILABLE }),
        ),
        Effect.provideContext(services),
      ),
  };
  return {
    clientId: live.grant.clientId,
    grantId: live.grant.grantId,
    kind: 'ok',
    tools: () =>
      buildConnectionTools({
        backend,
        catalog,
        crypto,
        description: live.description,
        prmUrl: endpoint.prmUrl,
        publicOrigin: endpoint.publicOrigin,
      }),
  } satisfies McpAuthentication;
});

const deps = { authenticate, config: endpointConfig };

const serve =
  <Failure, Requirements>(respond: (request: Request) => Effect.Effect<Response, Failure, Requirements>) =>
  (request: HttpServerRequest.HttpServerRequest) =>
    HttpServerRequest.toWeb(request).pipe(
      Effect.flatMap(respond),
      Effect.match({
        onFailure: () =>
          HttpServerResponse.text('MCP endpoint is unavailable', {
            headers: { 'cache-control': 'no-store' },
            status: 503,
          }),
        onSuccess: (response) =>
          HttpServerResponse.raw(response, { status: response.status, statusText: response.statusText }),
      }),
    );

/** The BFF transport layer of the MCP endpoint; its services are the same ones the agent platform handlers use. */
export const McpTransportLive = Layer.mergeAll(
  HttpRouter.add('*', MCP_BFF_ROUTE, serve(serveMcp(deps))),
  HttpRouter.add('*', MCP_METADATA_BFF_ROUTE, serve(serveMcpMetadata(deps))),
);
