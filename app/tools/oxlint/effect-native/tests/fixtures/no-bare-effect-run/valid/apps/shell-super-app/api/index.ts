import { Effect } from 'effect';

declare const handle: (request: Request) => Effect.Effect<Response>;

/** A1: the single outer framework adapter seam is allowed to run the program. */
export default async function bff(request: Request): Promise<Response> {
	return await Effect.runPromise(handle(request));
}
