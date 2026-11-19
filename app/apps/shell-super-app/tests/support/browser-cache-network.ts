import { GatewayContextApiGroup, pinDocumentCompositionRevision } from '@app/shared-contracts';
import { networkIdle, serveApi, streamingBrowserNetwork } from '@app/shared-contracts/testing/http-double';
import { HttpApi } from '@modern-js/bff-effect/effect-client';
import { HttpApiBuilder, HttpRouter, HttpServerRequest, HttpServerResponse } from '@modern-js/bff-effect/effect-edge';
import { Deferred, Effect, Layer, Schema, Stream } from 'effect';

import { DocumentGatewayApiGroup } from '../../shared/document-gateway-api.ts';
import { clearBrowserRequestCache } from '../../src/routes/browser-request-cache.ts';
import { warmDocumentGatewayAssertions } from '../../src/routes/document-gateway-assertions.ts';

export interface CacheRequest {
  readonly authorization: string | undefined;
  readonly body: string;
  readonly path: string;
  readonly signal: AbortSignal;
}

const freshOwnerAnswer = (_request: CacheRequest) => HttpServerResponse.jsonUnsafe({ value: 'fresh' });

/** The real browser transport and Shell contracts; only the server's owner data and assertion issuer are scripted. */
export const makeBrowserCacheNetwork = (audience: string, revision: string) => {
  const base: `/${string}` = `/shell-super-app-api/module-api/${audience}/build/fixture`;
  const requests: CacheRequest[] = [];
  const singles: string[] = [];
  const batches: (readonly string[])[] = [];
  const queued = new Map<string, Effect.Effect<HttpServerResponse.HttpServerResponse>[]>();
  const token = 'initial-token';
  let initialBatch = false;
  let issued = 0;
  let answerOwner = freshOwnerAnswer;
  const assertion = (issuedToken: string) => ({
    apiBaseUrl: base,
    compositionRevision: revision,
    expiresAt: 4_102_444_800,
    token: issuedToken,
  });
  const Api = HttpApi.make('cacheNetwork')
    .add(DocumentGatewayApiGroup)
    .add(GatewayContextApiGroup)
    .prefix('/shell-super-app-api');
  const handlers = Layer.mergeAll(
    HttpApiBuilder.group(Api, 'documentGateway', (group) =>
      group.handle('issueDocumentGatewayContexts', ({ payload }) =>
        Effect.sync(() => {
          batches.push(payload.audiences);
          if (!initialBatch) {
            return { assertions: [] };
          }
          initialBatch = false;
          return { assertions: [{ ...assertion(token), audience }] };
        }),
      ),
    ),
    HttpApiBuilder.group(Api, 'gatewayContext', (group) =>
      group
        .handle('issueGatewayContext', () =>
          Effect.sync(() => {
            issued += 1;
            const fresh = `t${issued}`;
            singles.push(fresh);
            return assertion(fresh);
          }),
        )
        .handle('issueApiKeyGatewayContext', () => Effect.die('Unexpected API-key issuance'))
        .handle('issueDelegatedGatewayContext', () => Effect.die('Unexpected delegated issuance')),
    ),
  );
  const receive = Effect.gen(function* receiveCacheRequest() {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const path = new URL(request.url, 'http://shell.test').pathname.slice(base.length);
    const body = yield* request.text.pipe(Effect.orDie);
    const source = Schema.decodeUnknownSync(Schema.instanceOf(Request))(request.source);
    const received = {
      authorization: request.headers['authorization'],
      body,
      path,
      signal: source.signal,
    };
    requests.push(received);
    return yield* queued.get(path)?.shift() ?? Effect.sync(() => answerOwner(received));
  });
  const network = streamingBrowserNetwork(serveApi(Api, handlers), HttpRouter.add('POST', `${base}/*`, receive));
  const enqueue = (path: string, answer: Effect.Effect<HttpServerResponse.HttpServerResponse>) => {
    const answers = queued.get(path) ?? [];
    answers.push(answer);
    queued.set(path, answers);
  };
  const hold = (path: string) =>
    Effect.gen(function* holdRequest() {
      const entered = yield* Deferred.make<boolean>();
      const release = yield* Deferred.make<HttpServerResponse.HttpServerResponse>();
      enqueue(path, Deferred.succeed(entered, true).pipe(Effect.andThen(Deferred.await(release))));
      return { entered, release };
    });
  const stream = (path: string, value: string) =>
    Effect.gen(function* holdBody() {
      const started = yield* Deferred.make<boolean>();
      const release = yield* Deferred.make<boolean>();
      const finished = yield* Deferred.make<boolean>();
      const body = Stream.fromEffect(
        Deferred.succeed(started, true).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.as(new TextEncoder().encode(value)),
        ),
      ).pipe(Stream.ensuring(Deferred.succeed(finished, true)));
      enqueue(path, Effect.succeed(HttpServerResponse.stream(body, { contentType: 'application/json' })));
      return { finished, release, started };
    });
  const gatewayRequest = () =>
    globalThis.fetch('/shell-super-app-api/auth/gateway-context', {
      body: JSON.stringify({ audience, compositionRevision: revision }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });
  const reset = (warm: boolean) =>
    Effect.gen(function* resetCacheNetwork() {
      requests.length = 0;
      singles.length = 0;
      batches.length = 0;
      queued.clear();
      issued = 0;
      initialBatch = warm;
      answerOwner = freshOwnerAnswer;
      globalThis.history.replaceState(null, '', '/en/home');
      globalThis.localStorage.clear();
      yield* clearBrowserRequestCache;
      yield* pinDocumentCompositionRevision(revision);
      if (warm) {
        yield* warmDocumentGatewayAssertions(revision, [audience]);
        yield* Effect.promise(gatewayRequest);
        yield* networkIdle;
      }
    });
  return {
    answerWith: (answer: typeof answerOwner) => {
      answerOwner = answer;
    },
    base,
    batches,
    get count() {
      return requests.length + singles.length;
    },
    enqueue,
    gatewayRequest,
    hold,
    network,
    requests,
    reset,
    singles,
    stream,
    get token() {
      return token;
    },
  };
};
