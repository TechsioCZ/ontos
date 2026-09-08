import { expect, it } from 'effect-rstest';
// @effect-diagnostics strictEffectProvide:off -- Test-owned HTTP application entrypoint; expires: 2026-12-31.
import { NodeHttpServer } from '@effect/platform-node';
import { Effect, Match, Redacted, Schema, Predicate } from 'effect';
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpServerRequest,
  HttpServerResponse,
} from 'effect/unstable/http';
import {
  OperationPrincipalVerificationErrorSchema,
  makeMicroverticalHttpPrincipalAuthentication,
} from '../../src/http/principal-authentication.ts';

const principal = {
  authBindingId: 'a1000000-0000-4000-8000-000000000001',
  authContextRef: 'better-auth-session:http-adapter-test',
  authMethod: 'session' as const,
  principalId: 'a2000000-0000-4000-8000-000000000001',
  tenantId: 'a3000000-0000-4000-8000-000000000001',
};

const verificationFailure = (
  _tag: (typeof OperationPrincipalVerificationErrorSchema.Type)['_tag'],
) =>
  Schema.decodeUnknownEffect(OperationPrincipalVerificationErrorSchema)({
    _tag,
    reason: 'Private verifier diagnostic',
  }).pipe(Effect.orDie);

const authenticationProblem = () => ({
  _tag: 'FixtureAuthenticationProblem' as const,
  detail: 'A valid audience-scoped Bearer assertion is required.',
  status: 401 as const,
  title: 'Authentication required',
  type: 'https://ontos.dev/problems/operation-authentication-required',
});
const unavailableProblem = () => ({
  _tag: 'FixtureUnavailableProblem' as const,
  detail: 'The fixture capability is temporarily unavailable.',
  retryable: true as const,
  status: 503 as const,
  title: 'Fixture unavailable',
  type: 'https://ontos.dev/problems/fixture-unavailable',
});
const ProblemResponseSchema = Schema.Struct({
  _tag: Schema.Literals(['FixtureAuthenticationProblem', 'FixtureUnavailableProblem']),
  status: Schema.Literals([401, 503]),
});
const SuccessResponseSchema = Schema.Struct({ principal: Schema.Unknown });

const problemResponse = (
  problem: ReturnType<typeof authenticationProblem | typeof unavailableProblem>,
) =>
  HttpServerResponse.jsonUnsafe(problem, { status: problem.status }).pipe(
    HttpServerResponse.setHeader('content-type', 'application/problem+json'),
  );
const respondWithProblem = (
  error: ReturnType<typeof authenticationProblem | typeof unavailableProblem>,
) => Effect.succeed(problemResponse(error));

it.live(
  'mounted HTTP authentication maps verifier classes, challenges unusable credentials, and stops before private logic',
  () => {
    let privateOperationReached = 0;
    const failureByCredential = new Map<
      string | undefined,
      (typeof OperationPrincipalVerificationErrorSchema.Type)['_tag']
    >([
      [undefined, 'ActionPrincipalMissingError'],
      ['Bearer malformed', 'ActionPrincipalInvalidError'],
      ['Bearer expired', 'ActionPrincipalExpiredError'],
      ['Bearer wrong-scope', 'ActionPrincipalScopeError'],
      ['Bearer misconfigured', 'ActionPrincipalConfigurationError'],
      ['Bearer unavailable', 'ActionPrincipalUnavailableError'],
    ]);
    const authenticate = makeMicroverticalHttpPrincipalAuthentication((authorization) => {
      const raw = Redacted.value(authorization);
      const failure = failureByCredential.get(raw);
      return failure === undefined
        ? Effect.succeed(principal)
        : verificationFailure(failure).pipe(Effect.flatMap(Effect.fail));
    });

    return Effect.gen(function* mountedAuthenticationHandler() {
      const server = yield* NodeHttpServer.make(
        () => process.getBuiltinModule('http').createServer(),
        { host: '127.0.0.1', port: 0 },
      );
      const application = HttpServerRequest.HttpServerRequest.use((request) =>
        authenticate(Redacted.make(request.headers['authorization']), {
          authentication: authenticationProblem,
          unavailable: unavailableProblem,
        }).pipe(
          Effect.flatMap((trustedPrincipal) =>
            Effect.sync(() => {
              privateOperationReached += 1;
              return HttpServerResponse.jsonUnsafe({ principal: trustedPrincipal });
            }),
          ),
          Effect.catch(respondWithProblem),
        ),
      );
      yield* server.serve(application);
      const address = yield* Match.value(server.address).pipe(
        Match.tag('TcpAddress', (tcpAddress) => Effect.succeed(tcpAddress)),
        Match.orElse(() => Effect.die('HTTP authentication fixture did not bind to TCP')),
      );
      const client = yield* HttpClient.HttpClient;
      const url = `http://127.0.0.1:${address.port}/operation`;
      for (const [authorization, expectedStatus] of [
        [undefined, 401],
        ['Bearer malformed', 401],
        ['Bearer expired', 401],
        ['Bearer wrong-scope', 401],
        ['Bearer misconfigured', 503],
        ['Bearer unavailable', 503],
      ] as const) {
        const request =
          authorization === undefined
            ? HttpClientRequest.get(url)
            : HttpClientRequest.get(url).pipe(
                HttpClientRequest.setHeader('authorization', authorization),
              );
        const response = yield* client.execute(request);
        expect(response.status).toBe(expectedStatus);
        expect(response.headers['content-type']).toBe('application/problem+json');
        expect(response.headers['www-authenticate']).toBe(
          expectedStatus === 401 ? 'Bearer' : undefined,
        );
        const rawBody = yield* response.json;
        expect(rawBody).toEqual(
          expectedStatus === 401 ? authenticationProblem() : unavailableProblem(),
        );
        const body = yield* Schema.decodeUnknownEffect(ProblemResponseSchema)(rawBody);
        expect(
          Predicate.isTagged(
            body,
            expectedStatus === 401 ? 'FixtureAuthenticationProblem' : 'FixtureUnavailableProblem',
          ),
        ).toBe(true);
        expect(body.status).toBe(expectedStatus);
      }
      expect(privateOperationReached).toBe(0);

      const success = yield* client.execute(
        HttpClientRequest.get(url).pipe(
          HttpClientRequest.setHeader('authorization', 'Bearer valid'),
        ),
      );
      expect(success.status).toBe(200);
      const successBody = yield* success.json.pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(SuccessResponseSchema)),
      );
      expect(successBody.principal).toEqual(principal);
      expect(privateOperationReached).toBe(1);
    }).pipe(Effect.provide(FetchHttpClient.layer));
  },
);
