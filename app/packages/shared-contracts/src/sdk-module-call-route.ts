/**
 * `@app/shared-contracts/server/sdk-module-call-route`: the governed HTTP route of the Core SDK's `call`
 * to a vertical's operation. It replaces what a module assembled by hand before: the delegated gateway
 * credential for the selected caller, the provider deployment's base URL, the admitted composition
 * revision and the governed request headers. Every vertical host provides `ModuleCallRouteLive` to its
 * read runtime, with `Crypto` and its fetch client (no cache, no redirect) composed at its root.
 */
import { ModuleCallRoute, RouteAnswerSchema } from '@app/core-runtime/execution/module-call-route';
import type { CallRouteRequest, RouteAnswer } from '@app/core-runtime/execution/module-call-route';
import { ModuleOperationRouteSchema } from '@app/core-runtime/sdk';
import { Crypto, Effect, Layer, Match, Option, Redacted, Schema } from 'effect';
import { HttpClient, HttpClientRequest } from 'effect/http';

import { acquireDelegatedGatewayContext } from './gateway-context-server.ts';
import type { GatewayDelegationRequest, GatewayDelegationSubject } from './gateway-context-server.ts';

type DelegationAttempt = ReturnType<typeof acquireDelegatedGatewayContext>;
type AcquiredDelegation = Pick<
  Effect.Success<DelegationAttempt>,
  'apiBaseUrl' | 'authorization' | 'compositionRevision'
>;

/** The gateway delegation of this deployment's own module credential (`acquireDelegatedGatewayContext`). */
export interface GatewayDelegation {
  readonly acquire: (
    request: GatewayDelegationRequest,
  ) => Effect.Effect<AcquiredDelegation, Effect.Error<DelegationAttempt>>;
}

const [answered, problemAnswer, unreachable] = RouteAnswerSchema.members;

const PROVIDER_ANSWER_TIMEOUT = '20 seconds';

const problem = (status: number, reason: string, code: string | undefined): RouteAnswer =>
  problemAnswer.make(code === undefined ? { reason, status } : { code, reason, status });

/**
 * The gateway delegation subject of the selected caller: the person relayed as an `Assertion` of the
 * execution's verified scope; the module registered for the principal as a `RegisteredAssertion` naming
 * the requirement, the pinned principal and the recovery request when present. A worker delivery
 * (`workload`) and an in-process caller never reach this route today.
 */
export const delegationSubjectOf = (request: CallRouteRequest): Option.Option<GatewayDelegationSubject> => {
  const scope = request.execution.callerSource.principal;
  return Match.value(request.caller).pipe(
    Match.discriminatorsExhaustive('kind')({
      in_process: () => Option.none(),
      person: () => Option.some<GatewayDelegationSubject>({ _tag: 'Assertion', scope }),
      registered: ({ declarationKey, expectedPrincipalId, recoveryRequestHash }) => {
        const base = {
          _tag: 'RegisteredAssertion' as const,
          declarationKey,
          operationRequirementKey: request.requirement.requirementKey,
          scope,
        };
        const pinned = expectedPrincipalId === undefined ? base : { ...base, expectedPrincipalId };
        return Option.some<GatewayDelegationSubject>(
          recoveryRequestHash === undefined ? pinned : { ...pinned, recoveryRequestHash },
        );
      },
      workload: () => Option.none(),
    }),
  );
};

/** The provider deployment's operation URL: the delegated API base path followed by the operation path. */
export const operationUrl = (apiBaseUrl: string, path: string): URL => {
  const base = new URL(apiBaseUrl);
  return new URL(`${base.pathname.replace(/\/+$/u, '')}${path}`, base);
};

const ProblemBodySchema = Schema.Struct({
  _tag: Schema.optionalKey(Schema.String),
  code: Schema.optionalKey(Schema.String),
  detail: Schema.optionalKey(Schema.String),
  reasonCode: Schema.optionalKey(Schema.String),
  title: Schema.optionalKey(Schema.String),
});
type ProblemBody = typeof ProblemBodySchema.Type;

const problemOf = (status: number, body: Option.Option<ProblemBody>): RouteAnswer => {
  const parsed = Option.getOrUndefined(body);
  return problem(
    status,
    parsed?.detail ?? parsed?.title ?? `The provider answered HTTP ${String(status)}`,
    parsed?.reasonCode ?? parsed?.code ?? parsed?._tag,
  );
};

/** The headers the governed module client sends; absent values stay absent on the wire. */
const governedHeaders = (request: CallRouteRequest, credential: Redacted.Redacted, compositionRevision: string) => ({
  authorization: Redacted.value(credential),
  'idempotency-key': request.idempotencyKey,
  'x-correlation-id': request.execution.scope.correlationId,
  'x-ontos-composition-revision': compositionRevision,
  'x-trace-id': request.execution.scope.traceId,
});

/** The route over a given gateway delegation and the host's HTTP client. */
export const makeModuleCallRoute = Effect.fn('ModuleCallRoute.make')(function* makeModuleCallRoute(
  delegation: GatewayDelegation,
) {
  const http = yield* HttpClient.HttpClient;

  const post = Effect.fn('ModuleCallRoute.post')(function* post(
    request: CallRouteRequest,
    path: `/${string}`,
    issued: AcquiredDelegation,
  ) {
    const credential = Redacted.make(issued.authorization);
    const httpRequest = HttpClientRequest.post(operationUrl(issued.apiBaseUrl, path)).pipe(
      HttpClientRequest.setHeaders(governedHeaders(request, credential, issued.compositionRevision)),
      HttpClientRequest.bodyJsonUnsafe(request.encodedInput),
    );
    // The read budget bounds the whole execution; one provider exchange (request, headers and the whole
    // body) may take at most this long. A body that is not JSON is `None`; a stalled one is unreachable.
    const exchanged = yield* http.execute(httpRequest).pipe(
      Effect.flatMap((response) =>
        response.json.pipe(
          Effect.option,
          Effect.map((body) => ({ body, status: response.status })),
        ),
      ),
      Effect.timeout(PROVIDER_ANSWER_TIMEOUT),
      Effect.option,
    );
    if (Option.isNone(exchanged)) {
      return unreachable.make({ reason: 'The provider could not be reached' });
    }
    const { body, status } = exchanged.value;
    if (status >= 200 && status < 300) {
      return Option.match(body, {
        onNone: () => problem(502, 'The provider answer is not JSON', 'provider_answer_unreadable'),
        onSome: (encoded) => answered.make({ encoded }),
      });
    }
    return problemOf(status, body.pipe(Option.flatMap((json) => Schema.decodeUnknownOption(ProblemBodySchema)(json))));
  });

  const send = Effect.fn('ModuleCallRoute.send')(function* send(request: CallRouteRequest) {
    const subject = delegationSubjectOf(request);
    const route = Option.liftPredicate(request.operation.route, Schema.is(ModuleOperationRouteSchema));
    if (Option.isNone(route) || Option.isNone(subject) || request.caller.kind === 'in_process') {
      return problem(500, 'This call cannot be sent over the module route', 'module_route_unsupported');
    }
    const issued = yield* delegation
      .acquire({
        audience: request.requirement.providerAppId,
        legalEntityScope: request.caller.legalEntityScope,
        requestCorrelation: request.execution.scope.correlationId,
        subject: subject.value,
      })
      .pipe(Effect.option);
    if (Option.isNone(issued)) {
      return unreachable.make({ reason: 'The gateway did not delegate a credential for this call' });
    }
    if (issued.value.compositionRevision !== request.execution.facts.compositionRevision) {
      return problem(503, 'The gateway delegated under another composition revision', 'composition_revision_mismatch');
    }
    return yield* post(request, route.value.path, issued.value);
  });
  return ModuleCallRoute.of({ send });
});

/**
 * The governed module route of a vertical host: this deployment's own gateway delegation over the host's
 * HTTP client. Every host provides it to `makeReadRuntimeLive`, so a read that starts calling another
 * module needs no host change. The host's fetch client must neither cache nor follow redirects
 * (`FetchHttpClient.RequestInit` `{ cache: 'no-store', redirect: 'manual' }`), so the delegated
 * credential reaches only the provider deployment the gateway named.
 */
export const ModuleCallRouteLive: Layer.Layer<ModuleCallRoute, never, Crypto.Crypto | HttpClient.HttpClient> =
  Layer.effect(
    ModuleCallRoute,
    Crypto.Crypto.pipe(
      Effect.flatMap((crypto) =>
        makeModuleCallRoute({ acquire: (request) => acquireDelegatedGatewayContext(request, crypto) }),
      ),
    ),
  );
