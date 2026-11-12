/**
 * Shell MCP HTTP ingress. Every request authenticates a live connection; a request that needs the connection's tools
 * also describes its authority, live. SDK callbacks borrow only that request's services and its resolved principal.
 * No grant, request identity or mutable authority is retained across requests.
 */
import { ActionTransportMetadataSchema } from '@app/core-runtime';
import { Context, Crypto, Effect, Option, Predicate, Schema } from 'effect';
import { HttpRouter, HttpServerRequest, HttpServerResponse } from 'effect/http';

import { mcpMetadataUrlOf } from '../../shared/mcp-resource.ts';
import type { AgentPlatformCaller } from '../agent-platform/caller.ts';
import { callModuleAs } from '../agent-platform/module-call.ts';
import { listOwnAgentBatches, submitAgentProposals } from '../agent-platform/service-queue.ts';
import { AgentActionRequestIdentity } from '../auth/agent-action-request-identity.ts';
import { AgentReadRequestIdentity } from '../auth/agent-request-identity.ts';
import { ShellInstalledModuleCatalog } from '../modules/installed-module-catalog.ts';
import { CapturedShellCompositionCatalog } from '../modules/captured-shell-catalog.ts';
import { connectionScopeOf, describeLiveGrant } from '../oauth-connections/connection-service.ts';
import type { LiveGrant } from '../oauth-connections/connection-service.ts';
import { loadOAuthServerConfig } from '../oauth-connections/server-config.ts';
import { loadMcpCatalog } from './catalog.ts';
import { authenticateMcpRequest, connectionPrincipalContext } from './connection.ts';
import { serveMcp, serveMcpMetadata } from './http.ts';
import type { McpAuthentication, McpConnectionTools, McpEndpointConfig } from './http.ts';
import { timedDescription } from './describe-timing.ts';
import { buildConnectionTools } from './tools.ts';
import type { McpBackend } from './types.ts';
import { ModuleUnavailable } from './module-unavailable.ts';
import { ProposalRefused } from './proposal-refused.ts';
import { searchMcpRecords } from './record-search.ts';

/** The grant's current authority, the installed release and its MCP catalog: what a tool list is built from. */
const describeConnection = Effect.fn('Mcp.describeConnection')(function* describeConnection(grant: LiveGrant) {
  const live = yield* describeLiveGrant(grant);
  const installed = yield* (yield* ShellInstalledModuleCatalog).load;
  return { catalog: yield* loadMcpCatalog(installed.composition), installed, live };
});

const refusalOf = (cause: unknown) =>
  Effect.logWarning('MCP authentication failed', cause).pipe(
    Effect.as(Predicate.isTagged(cause, 'ConnectionUnauthorized') ? ('invalid' as const) : ('unavailable' as const)),
  );

/** SDK callbacks borrow the admitted request's services; each mutation binds its own explicit caller intent. */
type McpBackendServices = Exclude<
  | Effect.Services<ReturnType<typeof callModuleAs>>
  | Effect.Services<ReturnType<typeof listOwnAgentBatches>>
  | Effect.Services<ReturnType<typeof submitAgentProposals>>
  | Effect.Services<ReturnType<typeof searchMcpRecords>>,
  AgentActionRequestIdentity | AgentReadRequestIdentity
>;

const QUEUE_UNAVAILABLE = 'Fronta návrhů teď není dostupná. Zkuste to za chvíli.';
const ENDPOINT_UNAVAILABLE = 'MCP endpoint is unavailable';

const McpCallerIntentKeySchema = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(200),
  Schema.isPattern(/^[!-~]+$/u),
).pipe(Schema.brand('McpCallerIntentKey'));

/** Authenticated SDK boundary: a tool key is intent, never a principal or authority.
 * Borrow the real read transport of this admitted request, not an envelope-wide Action/header identity.
 */
export const withMcpActionIntent = Effect.fn('Mcp.withActionIntent')(function* bindMcpActionIntent<A, E, R>(
  program: Effect.Effect<A, E, R>,
  intent: { readonly idempotencyKey: string },
) {
  const idempotencyKey = yield* Schema.decodeEffect(McpCallerIntentKeySchema)(intent.idempotencyKey).pipe(
    Effect.mapError(
      (cause) => new ProposalRefused({ cause, message: 'Chybí platný idempotencyKey změny (1–200 znaků bez mezer).' }),
    ),
  );
  const readIdentity = yield* Effect.serviceOption(AgentReadRequestIdentity);
  if (Option.isNone(readIdentity)) {
    return yield* new ProposalRefused({ message: 'Chybí identita původního MCP požadavku.' });
  }
  const services = yield* Effect.context<Exclude<R, AgentActionRequestIdentity>>();
  return yield* program.pipe(
    Effect.provideContext(
      Context.add(services, AgentActionRequestIdentity, {
        ...readIdentity.value,
        idempotencyKey,
      }),
    ),
  );
});

// The module owns its opaque body. This boundary owns the module target, path and replay metadata.
const McpModuleCallSchema = Schema.Struct({
  appId: Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]{0,99}$/u)).pipe(Schema.brand('McpModuleAppId')),
  body: Schema.Json,
  options: Schema.Struct({
    idempotencyKey: ActionTransportMetadataSchema.fields.idempotencyKey,
    referenceAudiences: Schema.optionalKey(Schema.Array(Schema.NonEmptyString)),
  }),
  path: Schema.String.check(Schema.isPattern(/^\/(?!\/)/u)).pipe(Schema.brand('McpModulePath')),
});

const endpointConfig = loadOAuthServerConfig.pipe(
  Effect.map(({ issuer, resource }): McpEndpointConfig => ({
    issuer,
    prmUrl: mcpMetadataUrlOf(resource),
    publicOrigin: new URL(resource).origin,
    resource,
  })),
);

const authenticate = Effect.fn('Mcp.authenticateRequest')(function* authenticateRequest(token: string) {
  const readIdentity = yield* Effect.serviceOption(AgentReadRequestIdentity);
  if (Option.isNone(readIdentity)) {
    return { kind: 'unavailable' } satisfies McpAuthentication;
  }
  // Token, grant and every live check ran; a refused or unreadable connection is answered before any MCP handling.
  const checked = yield* authenticateMcpRequest(token).pipe(
    Effect.matchEffect({
      onFailure: (cause) => refusalOf(cause).pipe(Effect.map((kind) => ({ kind }))),
      onSuccess: (live) => Effect.succeed({ kind: 'ok' as const, live }),
    }),
  );
  if (checked.kind !== 'ok') {
    return { kind: checked.kind } satisfies McpAuthentication;
  }
  const endpoint = yield* endpointConfig;
  const crypto = yield* Crypto.Crypto;
  // Capture at the HTTP/SDK boundary, not in a native service implementation. Nothing survives this request.
  const requestServices = Context.add(
    yield* Effect.context<McpBackendServices | Effect.Services<ReturnType<typeof describeConnection>>>(),
    AgentReadRequestIdentity,
    readIdentity.value,
  );
  const tools = timedDescription(describeConnection(checked.live)).pipe(
    Effect.map(([{ catalog, installed, live }, timing]): McpConnectionTools => {
      const principal = connectionPrincipalContext(live);
      // The caller's own resolved scope: the persisted grant's acting principal, never a scalar identity
      // rebuilt at the call site, so every gate question of this MCP request runs in one trusted scope (O66).
      const caller: AgentPlatformCaller = {
        legalName: live.description.legalName,
        principal,
        scope: connectionScopeOf(live.grant),
      };
      const services = Context.add(requestServices, CapturedShellCompositionCatalog, installed);
      const backend: McpBackend = {
        callModule: (appId, path, body, options) =>
          Schema.decodeEffect(McpModuleCallSchema)({ appId, body, options, path }).pipe(
            Effect.flatMap((call) => callModuleAs(principal, call.appId, call.path, call.body, call.options)),
            Effect.flatMap(Schema.decodeUnknownEffect(Schema.Struct({ body: Schema.Json, status: Schema.Finite }))),
            Effect.tapError((cause) => Effect.logError('MCP module call failed', cause)),
            Effect.mapError(
              (cause) =>
                new ModuleUnavailable({
                  cause,
                  message: Predicate.isTagged(cause, 'AgentModuleCallError')
                    ? cause.reason
                    : 'Neplatný požadavek modulu.',
                }),
            ),
            Effect.provideContext(services),
          ),
        listProposals: listOwnAgentBatches(caller).pipe(
          Effect.tapError((failure) => Effect.logError('MCP proposal queue failed', failure)),
          Effect.mapError((cause) => new ModuleUnavailable({ cause, message: `${QUEUE_UNAVAILABLE} (${cause._tag})` })),
          Effect.provideContext(services),
        ),
        // This closure and its native services belong only to this verified SDK request. The adapter re-verifies the
        // original credential and current grant/composition on every call; no authority survives another request.
        searchRecords: (search) => searchMcpRecords(live.description, search).pipe(Effect.provideContext(services)),
        submitProposals: (request, intent) =>
          withMcpActionIntent(
            submitAgentProposals(caller, request).pipe(
              Effect.tapError((failure) => Effect.logError('MCP proposal submission failed', failure)),
              Effect.mapError((cause) =>
                Predicate.isTagged(cause, 'AgentPlatformInvalid') || Predicate.isTagged(cause, 'AgentPlatformForbidden')
                  ? new ProposalRefused({ cause, message: cause.reason })
                  : new ModuleUnavailable({ cause, message: `${QUEUE_UNAVAILABLE} (${cause._tag})` }),
              ),
            ),
            intent,
          ).pipe(Effect.provideContext(services)),
      };
      return {
        kind: 'ok',
        timing,
        tools: buildConnectionTools({
          backend,
          catalog,
          crypto,
          description: live.description,
          prmUrl: endpoint.prmUrl,
          publicOrigin: endpoint.publicOrigin,
        }),
      };
    }),
    Effect.matchEffect({
      onFailure: (error) => refusalOf(error).pipe(Effect.map((kind): McpConnectionTools => ({ kind }))),
      onSuccess: Effect.succeed,
    }),
    Effect.provideContext(requestServices),
  );
  return {
    clientId: checked.live.grant.clientId,
    grantId: checked.live.grant.grantId,
    kind: 'ok',
    tools,
  } satisfies McpAuthentication;
});

const deps = { authenticate, config: endpointConfig };

// serveMcp owns public OPTIONS, landing pages and missing-bearer discovery. Only its authenticated branch
// needs root-bound request identity; constructing these callbacks never resolves a request service.
const serveMcpRequest = (request: Request) =>
  serveMcp({
    authenticate: Effect.fn('Mcp.authenticateIngress')(function* authenticateIngress(token: string) {
      const correlationId = request.headers.get('x-correlation-id');
      const identity = yield* Effect.serviceOption(AgentReadRequestIdentity);
      if (
        correlationId === null ||
        correlationId.length === 0 ||
        Option.isNone(identity) ||
        identity.value.correlationId !== correlationId
      ) {
        return { kind: 'unavailable' } satisfies McpAuthentication;
      }
      return yield* authenticate(token);
    }),
    config: endpointConfig,
  })(request);

export const serveMcpHttpAdapter =
  <Failure, Requirements>(respond: (request: Request) => Effect.Effect<Response, Failure, Requirements>) =>
  (request: HttpServerRequest.HttpServerRequest) =>
    HttpServerRequest.toWeb(request).pipe(
      Effect.flatMap((webRequest) => respond(new Request(webRequest, { headers: request.headers }))),
      Effect.map(HttpServerResponse.fromWeb),
      Effect.matchEffect({
        onFailure: (cause) =>
          Effect.logError('MCP HTTP transport failed', cause).pipe(
            Effect.as(
              HttpServerResponse.text(ENDPOINT_UNAVAILABLE, {
                headers: { 'cache-control': 'no-store' },
                status: 503,
              }),
            ),
          ),
        onSuccess: Effect.succeed,
      }),
    );

/** Native routes borrow the same request-scoped services as the platform's other authenticated handlers. */
const mcpEndpointHandler = serveMcpHttpAdapter(serveMcpRequest);
export const McpEndpointTransportLive = HttpRouter.add('*', '/mcp', (request) => mcpEndpointHandler(request));

/** Public metadata does not require a correlation or an Action identity. */
const mcpMetadataHandler = serveMcpHttpAdapter(serveMcpMetadata(deps));
export const McpMetadataTransportLive = HttpRouter.add('*', '/mcp-resource-metadata', (request) =>
  mcpMetadataHandler(request),
);
