import type { HttpApi, HttpApiGroup } from '@modern-js/bff-effect/effect-client';
import { FetchHttpClient, HttpApiBuilder, HttpRouter, HttpServer } from '@modern-js/bff-effect/effect-edge';
import { Clock, Effect, FiberSet, Layer } from 'effect';
import { flow } from 'effect/Function';

import { pinDocumentCompositionRevision } from '../../src/document-composition-revision.ts';
import {
  GatewayContextApi,
  GatewayForbiddenProblemSchema,
  shellGatewayContextContract,
} from '../../src/gateway-context.ts';
import type { GatewayContextResponse } from '../../src/gateway-context.ts';

/**
 * happy-dom's fetch seam, as its `IFetchInterceptor` declares it: an interceptor may answer a request before it
 * reaches the network, with a `Response` built by the window that sent it. Requests and responses keep the window's
 * fetch types.
 */
interface FetchInterceptor {
  readonly beforeAsyncRequest: (context: {
    readonly request: Request;
    readonly window: { readonly Response: typeof Response };
  }) => ReturnType<typeof fetch>;
}

declare global {
  /** The test DOM's own control surface; tests that render pages run under happy-dom. */
  interface Window {
    readonly happyDOM: { readonly settings: { readonly fetch: { interceptor: FetchInterceptor | null } } };
  }
}

/** An `HttpApiBuilder` layer with every handler provided: a whole server, short of its router. */
export type InProcessApplication = Layer.Layer<never, never, HttpRouter.HttpRouter>;

/**
 * Serves one real `HttpApi` with the handler groups a test wrote through `HttpApiBuilder.group`. Requests are
 * decoded and answers encoded by the API's own endpoint schemas. When the client sends to an owner prefix, build the
 * handlers and serve on the same `Api.prefix('/owner-api')` value: routes are read from the API the groups were built on.
 */
export const serveApi = <Id extends string, Groups extends HttpApiGroup.Constraint>(
  api: HttpApi.HttpApi<Id, Groups>,
  handlers: Layer.Layer<HttpApiGroup.ToService<Id, Groups>>,
): InProcessApplication =>
  HttpApiBuilder.layer(api).pipe(Layer.provide(handlers), Layer.provide(HttpServer.layerServices));

/** The web handler `HttpRouter.toWebHandler` builds over the applications, disposed with the scope. */
const served = (applications: readonly [InProcessApplication, ...InProcessApplication[]]) =>
  Effect.acquireRelease(
    Effect.sync(() => HttpRouter.toWebHandler(Layer.mergeAll(...applications), { disableLogger: true })),
    (server) => Effect.promise(server.dispose),
  );

type InProcessServer = Effect.Success<ReturnType<typeof served>>;

/**
 * Installs in-process servers as the fetch transport of a production client for an Effect the test runs itself.
 * The client keeps its own codecs, URL policy and error mapping; only the network hop is replaced, for the scope
 * that provides this layer.
 */
export const inProcessFetch = (...applications: readonly [InProcessApplication, ...InProcessApplication[]]) =>
  Layer.effect(FetchHttpClient.Fetch)(
    served(applications).pipe(
      Effect.map((server): typeof fetch =>
        flow((input: RequestInfo | URL, init?: RequestInit) => new Request(input, init), server.handler),
      ),
    ),
  );

/** The window's request as the server receives it: the same URL, method, headers and body. */
const serverRequest = (request: Request) => {
  const head = { headers: [...request.headers], method: request.method };
  return request.method === 'GET' || request.method === 'HEAD'
    ? Effect.succeed(new Request(request.url, head))
    : Effect.promise(async () => await request.arrayBuffer()).pipe(
        Effect.map((body) => new Request(request.url, { ...head, body })),
      );
};

/** The server's response as the window's own `Response`, which its fetch hands back to the page. */
const windowResponse = (response: Response, window: { readonly Response: typeof Response }) =>
  Effect.promise(async () => await response.arrayBuffer()).pipe(
    Effect.map(
      (body) =>
        new window.Response(body, {
          headers: [...response.headers],
          status: response.status,
          statusText: response.statusText,
        }),
    ),
  );

const windowAnswer =
  (server: InProcessServer) =>
  ({ request, window }: Parameters<FetchInterceptor['beforeAsyncRequest']>[0]) =>
    serverRequest(request).pipe(
      Effect.flatMap((forwarded) => Effect.promise(async () => await server.handler(forwarded))),
      Effect.flatMap((response) => windowResponse(response, window)),
    );

/**
 * Answers the test DOM's network with in-process servers, for pages and stores that run their client Effects
 * through the production browser runtime and so reach the network through the window's own fetch. happy-dom's fetch
 * interceptor is the DOM's network seam: requests keep the window's fetch semantics and only the server is in
 * process. Each answer runs in the layer's scope, so the interceptor and any request still in flight end with it.
 */
export const browserNetwork = (...applications: readonly [InProcessApplication, ...InProcessApplication[]]) =>
  Layer.effectDiscard(
    Effect.gen(function* interceptBrowserNetwork() {
      const server = yield* served(applications);
      const run = yield* FiberSet.makeRuntimePromise();
      const { fetch: network } = window.happyDOM.settings;
      const previous = network.interceptor;
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          network.interceptor = { beforeAsyncRequest: flow(windowAnswer(server), run) };
        }),
        () =>
          Effect.sync(() => {
            network.interceptor = previous;
          }),
      );
    }),
  );

/** The composition revision the test document pins and the Shell double issues gateway contexts for. */
export const testCompositionRevision = 'c'.repeat(64);

/**
 * Pins the test document to `testCompositionRevision` through the production pin, as the Shell does when it serves
 * the document. The pin is sealed for the document's life, so pin once per file (for example in `beforeAll`).
 */
export const pinTestDocument = pinDocumentCompositionRevision(testCompositionRevision);

/** One gateway context the Shell double issued: the module audience it was asked for. */
export interface IssuedGatewayContext {
  readonly audience: string;
  readonly token: string;
}

const forbidden = GatewayForbiddenProblemSchema.make({
  detail: 'The audience is not installed in the test composition.',
  status: GatewayForbiddenProblemSchema.fields.status.literal,
  title: 'Gateway context forbidden',
  type: 'https://ontos.dev/problems/gateway-forbidden',
});

/**
 * The Shell's session gateway-context issuer, served through the real `GatewayContextApi`. Each module audience in
 * `apiBaseUrls` gets a fresh single-use token bound to its API base URL and the requested composition revision, as
 * the Shell issues them; any other audience is refused with the issuer's own GatewayForbiddenProblem. The API-key and
 * delegated issuers are not part of a browser session and fail the test when called.
 */
export const shellGatewayIssuer = (apiBaseUrls: Readonly<Record<string, string>>) => {
  const issued: IssuedGatewayContext[] = [];
  const issue = (payload: { readonly audience: string; readonly compositionRevision: string }) =>
    Effect.gen(function* issueGatewayContext() {
      const apiBaseUrl = apiBaseUrls[payload.audience];
      if (apiBaseUrl === undefined) {
        return yield* Effect.fail(forbidden);
      }
      const token = `${payload.audience}-assertion-${issued.length + 1}`;
      issued.push({ audience: payload.audience, token });
      const now = yield* Clock.currentTimeMillis;
      const response: GatewayContextResponse = {
        apiBaseUrl,
        compositionRevision: payload.compositionRevision,
        expiresAt: Math.floor(now / 1000) + 300,
        token,
      };
      return response;
    });
  const api = GatewayContextApi.prefix(shellGatewayContextContract.apiPrefix);
  const handlers = Layer.mergeAll(
    HttpApiBuilder.group(api, 'gatewayContext', (group) =>
      group
        .handle('issueGatewayContext', ({ payload }) => issue(payload))
        .handle('issueApiKeyGatewayContext', () => Effect.die('A browser session never issues API-key contexts'))
        .handle('issueDelegatedGatewayContext', () => Effect.die('A browser session never issues delegated contexts')),
    ),
    HttpApiBuilder.group(api, 'apiKeyGatewayRead', (group) =>
      group.handle('readWithApiKeyGatewayContext', () => Effect.die('A browser session never relays API-key reads')),
    ),
  );
  return { application: serveApi(api, handlers), issued } as const;
};
