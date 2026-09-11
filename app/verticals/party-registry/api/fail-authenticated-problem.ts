import { Effect, HttpEffect, HttpServerResponse } from '@modern-js/bff-effect/effect-edge';

const bearerChallenge = HttpEffect.appendPreResponseHandler((_request, response) =>
  Effect.succeed(HttpServerResponse.setHeader(response, 'www-authenticate', 'Bearer')),
);

export const failAuthenticatedProblem = <Problem>(mapped: Problem, isAuthentication: (problem: Problem) => boolean) =>
  (isAuthentication(mapped) ? bearerChallenge : Effect.void).pipe(Effect.andThen(Effect.fail(mapped)));
