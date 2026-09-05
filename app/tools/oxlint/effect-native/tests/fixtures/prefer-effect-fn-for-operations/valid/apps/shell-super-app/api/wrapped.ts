import { Effect } from "effect";

const withTiming = <A>(label: string, program: A): A => {
	void label;
	return program;
};

/** Documented limitation: a wrapped program is not the returned expression. */
export const handle = (request: { readonly id: string }) =>
	withTiming(
		"handle",
		Effect.gen(function* () {
			yield* Effect.log(request.id);
		}),
	);

/** A pipeline that never returns a bare `Effect.gen`. */
export const mapped = (id: string) => Effect.succeed(id).pipe(Effect.map((value) => value.length));
