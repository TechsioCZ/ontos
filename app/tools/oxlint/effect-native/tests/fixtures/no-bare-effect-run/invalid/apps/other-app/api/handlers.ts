// expect-count: 2
import { Effect } from 'effect';

declare const handle: (request: Request) => Effect.Effect<Response>;

export const handler = async (request: Request): Promise<Response> => await Effect.runPromise(handle(request));

export const fire = (request: Request): void => {
	Effect.runCallback(handle(request), { onExit: () => undefined });
};
