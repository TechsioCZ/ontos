/**
 * Mounts the MCP endpoint on the Shell BFF (`/shell-super-app-api/mcp` and `/shell-super-app-api/mcp-resource-metadata`;
 * the root `/mcp` and `/.well-known/oauth-protected-resource[/mcp]` reach them through `rootRouteTarget`).
 * Every tool call runs in-process as the connection's principal: a fresh gateway assertion for the owning vertical,
 * dispatched to its BFF (service binding on Workers, its URL on Node), and proposals through the platform queue.
 */
import { Effect, Layer, Predicate } from 'effect';
import { HttpRouter, HttpServerRequest, HttpServerResponse } from 'effect/unstable/http';

import { MCP_BFF_ROUTE, MCP_METADATA_BFF_ROUTE, mcpMetadataUrlOf } from '../../shared/mcp-resource.ts';
import type { AgentPlatformCaller } from '../agent-platform/caller.ts';
import { callModuleAs } from '../agent-platform/module-call.ts';
import { listOwnAgentBatches, submitAgentProposals } from '../agent-platform/service-queue.ts';
import { ShellInstalledModuleCatalog } from '../modules/installed-module-catalog.ts';
import { loadOAuthServerConfig } from '../oauth-connections/server-config.ts';
import { loadMcpCatalog } from './catalog.ts';
import { authenticateMcpRequest, connectionPrincipalContext } from './connection.ts';
import { createMcpFetch, createMcpMetadataFetch } from './http.ts';
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

type McpServices =
  | Effect.Services<ReturnType<typeof callModuleAs>>
  | Effect.Services<ReturnType<typeof describeConnection>>
  | Effect.Services<ReturnType<typeof listOwnAgentBatches>>
  | Effect.Services<ReturnType<typeof submitAgentProposals>>
  | Effect.Services<typeof loadOAuthServerConfig>;

const reasonOf = (error: unknown, fallback: string): string => {
  const reason: unknown = Predicate.isObject(error) ? Reflect.get(error, 'reason') : undefined;
  return typeof reason === 'string' ? reason : fallback;
};

const makeRoutes = Effect.gen(function* makeMcpRoutes() {
  const run = Effect.runPromiseWith(yield* Effect.context<McpServices>());

  const config = async (): Promise<McpEndpointConfig> => {
    const { issuer, resource } = await run(loadOAuthServerConfig);
    return { issuer, prmUrl: mcpMetadataUrlOf(resource), publicOrigin: new URL(resource).origin, resource };
  };

  const authenticate = async (token: string): Promise<McpAuthentication> => {
    const outcome = await run(
      describeConnection(token).pipe(
        Effect.map((value) => ({ _tag: 'ok' as const, ...value })),
        Effect.catch((error) =>
          Effect.succeed({ _tag: Predicate.isTagged(error, 'ConnectionUnauthorized') ? ('invalid' as const) : ('unavailable' as const) }),
        ),
        Effect.catchDefect((defect) =>
          Effect.logError('MCP authentication defect', defect).pipe(Effect.as({ _tag: 'unavailable' as const })),
        ),
      ),
    );
    if (outcome._tag !== 'ok') {
      return { kind: outcome._tag };
    }
    const { catalog, live } = outcome;
    const principal = connectionPrincipalContext(live);
    const caller: AgentPlatformCaller = { legalName: live.description.legalName, principal };
    const endpoint = await config();
    const backend: McpBackend = {
      callModule: (appId, path, body, options) =>
        run(
          callModuleAs(principal, appId, path, body, {
            ...(options.idempotencyKey === undefined ? {} : { idempotencyKey: options.idempotencyKey }),
            ...(options.referenceAudiences === undefined ? {} : { referenceAudiences: options.referenceAudiences }),
          }).pipe(Effect.mapError((error) => new ModuleUnavailable(error.reason))),
        ),
      listProposals: () =>
        run(
          listOwnAgentBatches(caller).pipe(
            Effect.mapError(() => new ModuleUnavailable('Fronta návrhů teď není dostupná. Zkuste to za chvíli.')),
          ),
        ),
      submitProposals: (request) =>
        run(
          submitAgentProposals(caller, request).pipe(
            Effect.mapError((error) =>
              Predicate.isTagged(error, 'AgentPlatformInvalid') || Predicate.isTagged(error, 'AgentPlatformForbidden')
                ? new ProposalRefused(reasonOf(error, 'Návrh nebyl přijat.'))
                : new ModuleUnavailable('Fronta návrhů teď není dostupná. Zkuste to za chvíli.'),
            ),
          ),
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
          description: live.description,
          prmUrl: endpoint.prmUrl,
          publicOrigin: endpoint.publicOrigin,
        }),
    };
  };

  const serve = (fetch: (request: Request) => Promise<Response>) => (request: HttpServerRequest.HttpServerRequest) =>
    HttpServerRequest.toWeb(request).pipe(
      Effect.flatMap((webRequest) => Effect.promise(() => fetch(webRequest))),
      Effect.match({
        onFailure: () =>
          HttpServerResponse.text('MCP endpoint is unavailable', { headers: { 'cache-control': 'no-store' }, status: 503 }),
        onSuccess: (response) =>
          HttpServerResponse.raw(response, { status: response.status, statusText: response.statusText }),
      }),
    );

  return Layer.mergeAll(
    HttpRouter.add('*', MCP_BFF_ROUTE, serve(createMcpFetch({ authenticate, config }))),
    HttpRouter.add('*', MCP_METADATA_BFF_ROUTE, serve(createMcpMetadataFetch({ config }))),
  );
});

/** The BFF transport layer of the MCP endpoint; its services are the same ones the agent platform handlers use. */
export const McpTransportLive = Layer.unwrap(makeRoutes);
