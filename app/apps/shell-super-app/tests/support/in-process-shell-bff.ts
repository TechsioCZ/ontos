import { FetchHttpClient, HttpRouter } from '@modern-js/bff-effect/effect-edge';
import { Effect, FiberSet, Layer } from 'effect';
import { flow } from 'effect/Function';
import type { BrowserWindow, DetachedWindowAPI, Request as WindowRequest } from 'happy-dom';

declare global {
  /** The test DOM's own control surface; the unit project runs every page under happy-dom. */
  interface Window {
    readonly happyDOM: DetachedWindowAPI;
  }
}

/** An `HttpApiBuilder` layer with every handler provided: the whole BFF, short of its router. */
export type InProcessBffApplication = Layer.Layer<never, never, HttpRouter.HttpRouter>;

/** The web handler `HttpRouter.toWebHandler` builds over the application, disposed with the scope. */
const served = (application: InProcessBffApplication) =>
  Effect.acquireRelease(
    Effect.sync(() => HttpRouter.toWebHandler(application, { disableLogger: true })),
    (server) => Effect.promise(server.dispose),
  );

/**
 * Installs an in-process BFF as the fetch transport of the production browser client for an Effect
 * the test runs itself. The client keeps its own codecs, URL policy and error mapping; only the
 * network hop is replaced, for the scope that provides this layer.
 */
export const inProcessShellBff = (application: InProcessBffApplication) =>
  Layer.effect(FetchHttpClient.Fetch)(
    served(application).pipe(
      Effect.map((server): typeof fetch =>
        flow((input: RequestInfo | URL, init?: RequestInit) => new Request(input, init), server.handler),
      ),
    ),
  );

/** The window's request as the server receives it: the same URL, method, headers and body. */
const serverRequest = (request: WindowRequest) => {
  const head = { headers: [...request.headers], method: request.method };
  return request.method === 'GET' || request.method === 'HEAD'
    ? Effect.succeed(new Request(request.url, head))
    : Effect.promise(async () => await request.arrayBuffer()).pipe(
        Effect.map((body) => new Request(request.url, { ...head, body })),
      );
};

type InProcessServer = Effect.Success<ReturnType<typeof served>>;

/** The server's response as the window's own `Response`, which its fetch hands back to the page. */
const windowResponse = (response: Response, window: BrowserWindow) =>
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

const handled = (server: InProcessServer, request: Request) =>
  Effect.promise(async () => await server.handler(request));

/** One request the window's fetch sent, answered by the server in the window's own terms. */
const windowAnswer =
  (server: InProcessServer) =>
  ({ request, window }: { readonly request: WindowRequest; readonly window: BrowserWindow }) =>
    serverRequest(request).pipe(
      Effect.flatMap((forwarded) => handled(server, forwarded)),
      Effect.flatMap((response) => windowResponse(response, window)),
    );

/**
 * Answers the test DOM's network with an in-process BFF, for a page that runs its client Effects
 * through the production browser runtime and so reaches the network through the window's own
 * fetch. happy-dom's fetch interceptor is the DOM's network seam: requests keep the window's fetch
 * semantics and only the server is in process. Each answer runs in the layer's scope, so the
 * interceptor and any request still in flight end with it.
 */
export const browserNetworkShellBff = (application: InProcessBffApplication) =>
  Layer.effectDiscard(
    Effect.gen(function* interceptBrowserNetwork() {
      const server = yield* served(application);
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
