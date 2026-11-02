import { Effect, Option, Stream } from 'effect';
import { HttpRouter, HttpServerResponse } from 'effect/http';
import type { HttpServerRequest } from 'effect/http';

import { LiveChangeHub } from './hub.ts';
import { LiveScopeResolver } from './live-scope.ts';

/** Browser URL: `/shell-super-app-api/live-changes`. */
export const LIVE_CHANGES_PATH = '/live-changes';

const refusal = (status: number) =>
  HttpServerResponse.text('Live updates are unavailable for this session', {
    headers: { 'cache-control': 'no-store' },
    status,
  });

const serveLiveChanges = Effect.fn('LiveChanges.serve')(
  function* serveLiveChanges(request: HttpServerRequest.HttpServerRequest) {
    const resolver = yield* LiveScopeResolver;
    const hub = yield* LiveChangeHub;
    const scope = yield* resolver.resolve(request);
    // The browser resumes a cut stream with the id of the last frame it received.
    const frames = yield* hub.subscribe(scope, Option.fromNullishOr(request.headers['last-event-id']));
    if (Option.isNone(frames)) {
      return refusal(503);
    }
    return HttpServerResponse.stream(Stream.encodeText(frames.value), {
      contentType: 'text/event-stream; charset=utf-8',
      headers: {
        'cache-control': 'no-store, no-transform',
        // Proxies (the Zerops L7 balancer) must pass each frame through instead of buffering the response.
        'x-accel-buffering': 'no',
      },
      status: 200,
    });
  },
  Effect.catchTag('LiveScopeUnavailable', ({ status }) => Effect.succeed(refusal(status))),
);

/** `GET /live-changes`: the session's Server-Sent Events stream of app ids to revalidate. */
export const LiveChangesRouteLive = HttpRouter.add('GET', LIVE_CHANGES_PATH, serveLiveChanges);
