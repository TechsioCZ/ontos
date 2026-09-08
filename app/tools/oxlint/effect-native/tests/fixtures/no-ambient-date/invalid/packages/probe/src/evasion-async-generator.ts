// expect-count: 2
/** Async generator body: the visitor must still reach the ambient clock. */
export async function* heartbeats(): AsyncGenerator<number> {
	yield Date.now();
	yield new Date().valueOf();
}
