import { Effect, Layer, ServiceMap } from 'effect';

declare const inner: Effect.Effect<number>;
declare const database: { transaction: <A>(body: (tx: unknown) => Promise<A>) => Promise<A> };
declare const step: (tx: unknown) => Effect.Effect<number>;
declare const Tag: ServiceMap.Key<number, number>;

/** S1 deep re-entry inside an Effect-owned Drizzle bridge: reported by no-nested-effect-run, not here. */
export const transaction = Effect.tryPromise({
	catch: (error: unknown) => error,
	try: async () =>
		await database.transaction(async (tx: unknown) => {
			const exit = await Effect.runPromiseExit(step(tx));
			return exit;
		}),
});

export const program = Effect.gen(function* () {
	const value = yield* Effect.sync(() => Effect.runSync(inner));
	return value;
});

export const layer = Layer.effect(
	Tag,
	Effect.gen(function* () {
		return Effect.runSync(inner);
	}),
);

export const mapped = program.pipe(Effect.map(() => Effect.runSync(inner)));

export const traced = Effect.fn('traced')(function* () {
	return Effect.runSync(inner);
});
