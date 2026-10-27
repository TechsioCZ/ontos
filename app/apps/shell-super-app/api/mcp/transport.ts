/**
 * Shell MCP HTTP ingress. Every request authenticates a live connection; SDK callbacks borrow only that request's
 * services and its resolved principal. No grant, request identity or mutable authority is retained across requests.
 */
import { ActionTransportMetadataSchema } from '@app/core-runtime';
import { Context, Crypto, Effect, Option, Predicate, Schema } from 'effect';
import { HttpRouter, HttpServerRequest, HttpServerResponse } from 'effect/http';

import { MCP_BFF_ROUTE, MCP_METADATA_BFF_ROUTE, mcpMetadataUrlOf } from '../../shared/mcp-resource.ts';
import type { AgentPlatformCaller } from '../agent-platform/caller.ts';
import { callModuleAs } from '../agent-platform/module-call.ts';
import { listOwnAgentBatches, submitAgentProposals } from '../agent-platform/service-queue.ts';
import { AgentActionRequestIdentity } from '../auth/agent-action-request-identity.ts';
import { AgentReadRequestIdentity } from '../auth/agent-request-identity.ts';
import { ShellInstalledModuleCatalog } from '../modules/installed-module-catalog.ts';
import { loadOAuthServerConfig } from '../oauth-connections/server-config.ts';
import { loadMcpCatalog } from './catalog.ts';
import { authenticateMcpRequest, connectionPrincipalContext } from './connection.ts';
import { serveMcp, serveMcpMetadata } from './http.ts';
import type { McpAuthentication, McpEndpointConfig } from './http.ts';
import { buildConnectionTools } from './tools.ts';
import type { McpBackend } from './types.ts';
import { ModuleUnavailable } from './module-unavailable.ts';
import { ProposalRefused } from './proposal-refused.ts';

const describeConnection = Effect.fn('Mcp.describeConnection')(function* describeConnection(token: string) {
  const live = yield* authenticateMcpRequest(token);
  const installed = yield* (yield* ShellInstalledModuleCatalog).load;
  return { catalog: yield* loadMcpCatalog(installed.composition), live };
});

/** SDK callbacks borrow the admitted request's services; each mutation binds its own explicit caller intent. */
type McpBackendServices = Exclude<
  | Effect.Services<ReturnType<typeof callModuleAs>>
  | Effect.Services<ReturnType<typeof listOwnAgentBatches>>
  | Effect.Services<ReturnType<typeof submitAgentProposals>>,
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
  const outcome = yield* describeConnection(token).pipe(
    Effect.matchEffect({
      onFailure: (cause) =>
        Effect.logWarning('MCP authentication failed', cause).pipe(
          Effect.as({
            _tag: Predicate.isTagged(cause, 'ConnectionUnauthorized') ? ('invalid' as const) : ('unavailable' as const),
          }),
        ),
      onSuccess: (value) => Effect.succeed({ _tag: 'ok' as const, ...value }),
    }),
  );
  if (!Predicate.isTagged(outcome, 'ok')) {
    return { kind: outcome._tag } satisfies McpAuthentication;
  }
  const { catalog, live } = outcome;
  const principal = connectionPrincipalContext(live);
  const caller: AgentPlatformCaller = { legalName: live.description.legalName, principal };
  const endpoint = yield* endpointConfig;
  const crypto = yield* Crypto.Crypto;
  // Capture at the HTTP/SDK boundary, not in a native service implementation. Nothing survives this request.
  const services = Context.add(
    yield* Effect.context<McpBackendServices>(),
    AgentReadRequestIdentity,
    readIdentity.value,
  );
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
              message: Predicate.isTagged(cause, 'AgentModuleCallError') ? cause.reason : 'Neplatný požadavek modulu.',
            }),
        ),
        Effect.provideContext(services),
      ),
    listProposals: listOwnAgentBatches(caller).pipe(
      Effect.tapError((failure) => Effect.logError('MCP proposal queue failed', failure)),
      Effect.mapError((cause) => new ModuleUnavailable({ cause, message: `${QUEUE_UNAVAILABLE} (${cause._tag})` })),
      Effect.provideContext(services),
    ),
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
export const McpEndpointTransportLive = HttpRouter.add('*', MCP_BFF_ROUTE, serveMcpHttpAdapter(serveMcpRequest));

/** Public metadata does not require a correlation or an Action identity. */
export const McpMetadataTransportLive = HttpRouter.add(
  '*',
  MCP_METADATA_BFF_ROUTE,
  serveMcpHttpAdapter(serveMcpMetadata(deps)),
);
