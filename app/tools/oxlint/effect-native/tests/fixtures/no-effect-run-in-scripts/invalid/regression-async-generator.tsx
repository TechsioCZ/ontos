// expect-count: 1
// An exported async generator in a .tsx script is still a function body, not the edge.
import * as EffectNs from "effect/Effect";

const program = EffectNs.succeed(<span>ok</span>);

export async function* streamRows(): AsyncGenerator<unknown> {
	yield await EffectNs.runPromise(program);
}
