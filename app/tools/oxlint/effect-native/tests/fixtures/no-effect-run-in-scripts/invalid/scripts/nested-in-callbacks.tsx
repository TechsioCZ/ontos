// expect-count: 3
import * as EffectNs from "effect/Effect";

const program = EffectNs.succeed(<span>ok</span>);

export function Renderer(): unknown {
	const handle = (): void => {
		void EffectNs.runPromise(program);
	};
	return <button onClick={handle}>run</button>;
}

const timer = setTimeout(() => {
	void EffectNs.runFork(program);
}, 10);

export const helpers = {
	run: (): unknown => EffectNs.runSync(program),
};

void timer;
