import { Effect, pipe } from 'effect';

declare const handle: (request: Request) => Effect.Effect<Response>;

export const adapter = (request: Request): Promise<Response> => pipe(handle(request), Effect.runPromise);
