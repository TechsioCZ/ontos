// Locally bound names that merely spell `Error`: a class shadow, an injected constructor and a
// catch-clause parameter. None of them is the ambient global, so none of them reports.
class Error {
	constructor(readonly message: string) {}
}

export const shadowed = new Error("local class, not the global");

export function withInjectedConstructor(TypeError: new (message: string) => object): object {
	return new TypeError("injected constructor");
}

export const caught = (run: () => void): string => {
	try {
		run();
	} catch (RangeError) {
		return String(new RangeError());
	}
	return "ok";
};

export const isShadowed = (value: unknown): boolean => value instanceof Error;
