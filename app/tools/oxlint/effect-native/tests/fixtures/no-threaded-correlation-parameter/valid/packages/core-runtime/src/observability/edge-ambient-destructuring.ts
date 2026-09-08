// Destructuring outside a parameter list is the target shape, not threading.
import * as Effect from 'effect/Effect';

declare const RequestIdentity: Effect.Effect<{ readonly id: string }>;

export const operation = Effect.gen(function* () {
	const { id: correlationId } = yield* RequestIdentity;
	return correlationId;
});

export const fromRows = (rows: ReadonlyArray<{ readonly id: string }>) => {
	for (const { id: correlationId } of rows) void correlationId;
	let traceId = '';
	({ traceId } = { traceId: 'z' });
	return traceId;
};

export const caught = () => {
	try {
		return 1;
	} catch ({ correlationId }) {
		return correlationId;
	}
};
