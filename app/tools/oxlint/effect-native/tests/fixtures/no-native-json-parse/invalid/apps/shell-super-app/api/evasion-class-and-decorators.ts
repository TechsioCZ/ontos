// expect-count: 14
declare const s: string;
declare function inject(value: unknown): (target: unknown, context: unknown) => void;

@inject(JSON.parse(s))
export class Registry {
	@inject(JSON.parse(s))
	accessor overlay = 1;

	field = JSON.parse(s);
	static seed = JSON.parse(s);
	#hidden = JSON.parse(s);
	static {
		void JSON.parse(s);
	}
	get document() {
		return JSON.parse(s);
	}
	load(fallback = JSON.parse(s)) {
		return [fallback, this.#hidden];
	}
	[JSON.parse(s) as string]() {
		return 1;
	}
}

export async function* documents() {
	yield JSON.parse(s);
}

export const curried = () => () => () => JSON.parse(s);
export const interpolated = `${JSON.parse(s)}`;
export namespace Legacy {
	export const inside = JSON.parse(s);
}
export default JSON.parse;
