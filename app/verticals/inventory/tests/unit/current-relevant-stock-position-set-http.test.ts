import { ReadHandlerUnavailable, ReadRuntime } from '@app/core-runtime';
import { makeGovernedReadHttpHandler } from '@app/core-runtime/http/governed-read';
import { RequestSchemaProblemSchema } from '@app/shared-contracts/problem-details';
import { makeGovernedReadProblems } from '@app/shared-contracts/server/effect-bff-runtime';
import { RequestSchemaProblemLive } from '@app/shared-contracts/server/http-error-seam';
import { HttpApiBuilder, HttpRouter, HttpServer } from '@modern-js/bff-effect/effect-edge';
import { Context, Effect, Layer, Result, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';
import { FetchHttpClient } from 'effect/unstable/http';
import {
  CurrentRelevantStockPositionSetApi,
  CurrentRelevantStockPositionSetAuthenticationProblemSchema,
  CurrentRelevantStockPositionSetForbiddenProblemSchema,
  CurrentRelevantStockPositionSetInternalProblemSchema,
  CurrentRelevantStockPositionSetInvalidProblemSchema,
  CurrentRelevantStockPositionSetNotFoundProblemSchema,
  CurrentRelevantStockPositionSetPolicyConflictProblemSchema,
  CurrentRelevantStockPositionSetPolicyProblemSchema,
  CurrentRelevantStockPositionSetUnavailableProblemSchema,
} from '../../shared/apis/current-relevant-stock-position-set.ts';
import { executeCurrentRelevantStockPositionSetWithAuthorization } from '../../src/api/current-relevant-stock-position-set-client.ts';
import { currentRelevantStockPositionSetRead } from '../../src/api/current-relevant-stock-position-set.read.ts';
import { request, scope } from '../support/current-relevant-stock-position-set.ts';

const problems = makeGovernedReadProblems({
  authentication: CurrentRelevantStockPositionSetAuthenticationProblemSchema,
  forbidden: CurrentRelevantStockPositionSetForbiddenProblemSchema,
  internal: CurrentRelevantStockPositionSetInternalProblemSchema,
  invalid: CurrentRelevantStockPositionSetInvalidProblemSchema,
  notFound: CurrentRelevantStockPositionSetNotFoundProblemSchema,
  policyConflict: CurrentRelevantStockPositionSetPolicyConflictProblemSchema,
  policyIneligible: CurrentRelevantStockPositionSetPolicyProblemSchema,
  unavailable: CurrentRelevantStockPositionSetUnavailableProblemSchema,
});

describe('Current relevant StockPosition set HTTP request contract', () => {
  it.effect('real codec rejection is typed by the generated client before authentication or owner effects', () =>
    Effect.gen(function* malformedRequest() {
      let authenticationCalls = 0;
      let coreCalls = 0;
      const handler = makeGovernedReadHttpHandler({
        authenticatePrincipal: () => {
          authenticationCalls += 1;
          return Effect.succeed(scope);
        },
        problems,
        registration: currentRelevantStockPositionSetRead,
      });
      const handlers = HttpApiBuilder.group(
        CurrentRelevantStockPositionSetApi,
        'currentRelevantStockPositionSet',
        (routes) => routes.handle('execute', handler),
      );
      const unusedRuntimeService = {
        runRead: () => {
          coreCalls += 1;
          return Effect.fail(new ReadHandlerUnavailable({ code: 'read_handler_unavailable', reason: 'unused' }));
        },
      };
      const requestContext = Context.make(ReadRuntime, unusedRuntimeService);
      const server = yield* Effect.acquireRelease(
        Effect.sync(() =>
          HttpRouter.toWebHandler(
            HttpApiBuilder.layer(CurrentRelevantStockPositionSetApi).pipe(
              Layer.provide(handlers),
              Layer.provideMerge(RequestSchemaProblemLive),
              Layer.provide(Layer.succeed(ReadRuntime, unusedRuntimeService)),
              Layer.provide(HttpServer.layerServices),
            ),
            { disableLogger: true },
          ),
        ),
        (runtime) => Effect.promise(() => runtime.dispose()).pipe(Effect.orDie),
      );
      const badPayload = { ...request, mode: 'secret-invalid-mode' };
      const direct = yield* Effect.promise(() =>
        server.handler(
          new Request('https://inventory.example/reads/current-relevant-stock-position-set', {
            body: JSON.stringify(badPayload),
            headers: { 'content-type': 'application/json', 'x-correlation-id': 'invalid-http-test' },
            method: 'POST',
          }),
          requestContext,
        ),
      );
      expect(direct.status).toBe(400);
      expect(direct.headers.get('content-type')).toContain('application/problem+json');
      const problem = yield* Effect.promise(() => direct.json()).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(RequestSchemaProblemSchema)),
      );
      expect(problem.paths).toContain('mode');
      expect(JSON.stringify(problem)).not.toContain('secret-invalid-mode');
      const routerFetch: typeof fetch = (url, init) =>
        server.handler(new Request(url, { ...init, body: JSON.stringify(badPayload) }), requestContext);
      const clientResult = yield* executeCurrentRelevantStockPositionSetWithAuthorization(
        request,
        'Bearer controlled',
        'http-test',
        { baseUrl: 'https://inventory.example' },
      ).pipe(Effect.provideService(FetchHttpClient.Fetch, routerFetch), Effect.result);
      expect(Result.isFailure(clientResult)).toBe(true);
      if (Result.isFailure(clientResult)) {
        expect(Schema.is(RequestSchemaProblemSchema)(clientResult.failure)).toBe(true);
      }
      expect(authenticationCalls).toBe(0);
      expect(coreCalls).toBe(0);
    }),
  );
});
