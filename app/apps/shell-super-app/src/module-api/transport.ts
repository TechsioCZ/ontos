import {
  ActiveApplicationCompositionService,
  validateActiveApplicationCompositionSnapshot,
} from '@app/core-runtime/modules/active-application-composition';
import type { ActiveApplicationCompositionServiceContract } from '@app/core-runtime/modules/active-application-composition';
import { moduleReleaseFetch } from '@app/core-runtime/unit-service-fetch';
import { Effect, Predicate } from 'effect';
import { HttpRouter, HttpServerRequest, HttpServerResponse } from 'effect/unstable/http';

import { admitModuleApiRequest } from './admission.ts';
import { relayModuleResponse } from './response-relay.ts';

const dispatchApprovedModuleApiRequest = Effect.fn('ModuleApi.dispatchApprovedRequest')(
  function* dispatchApprovedRequest(request: Request, authority: ActiveApplicationCompositionServiceContract) {
    const snapshot = yield* authority.load.pipe(Effect.flatMap(validateActiveApplicationCompositionSnapshot));
    const target = yield* admitModuleApiRequest(request, snapshot.composition);
    const response = yield* moduleReleaseFetch(target.forwardedRequest, target.module);
    // Applied at the dispatcher rather than the route, so every caller — including the exported
    // `dispatchModuleApiRequest` — gets the same response policy.
    return relayModuleResponse(response, new URL(request.url).origin);
  },
);

export const dispatchModuleApiRequest = Effect.fn('ModuleApi.dispatchRequest')(function* dispatchRequest(
  request: Request,
) {
  return yield* dispatchApprovedModuleApiRequest(request, yield* ActiveApplicationCompositionService);
});

/** Route registration is isolate-safe; dispatch resolves the serving request's composition authority. */
export const ModuleApiTransportLive = HttpRouter.add('*', '/module-api/*', (request) =>
  HttpServerRequest.toWeb(request).pipe(
    Effect.flatMap(dispatchModuleApiRequest),
    Effect.match({
      onFailure: (error) =>
        HttpServerResponse.text(
          Predicate.isTagged(error, 'ModuleApiDispatchError') ? error.reason : 'Approved module release is unavailable',
          {
            headers: { 'cache-control': 'no-store' },
            status: Predicate.isTagged(error, 'ModuleApiDispatchError') ? error.status : 503,
          },
        ),
      onSuccess: (response) =>
        HttpServerResponse.raw(response, { status: response.status, statusText: response.statusText }),
    }),
  ),
);
