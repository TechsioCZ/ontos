// expect-count: 4
// Async generator, curried arrow bodies, a default-parameter initialiser and a template message.
export async function* stream(): AsyncGenerator<number> {
	yield 1;
	throw new Error("async generator body");
}

export const curried = () => () => async (): Promise<never> => {
	throw new TypeError("nested arrow body");
};

export const defaulted = ({ make = () => new RangeError("default parameter") } = {}) => make();

export const interpolated = (id: string): unknown => new URIError(`bad id ${id}`);
