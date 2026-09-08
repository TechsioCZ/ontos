// False-positive probe: an immutable module-level record of functions. `contactStorage.set(...)`
// calls a member function; it does not mutate `contactStorage`, which is never reassigned or
// written to. Reporting this would flag every adapter object that happens to expose `set`/`add`.
const contactStorage = {
	get: (key: string): string | null => globalThis.localStorage.getItem(key),
	set: (key: string, value: string): void => {
		globalThis.localStorage.setItem(key, value);
	},
};

export const readContact = (key: string): string | null => contactStorage.get(key);

export const persistContact = (key: string, value: string): void => {
	contactStorage.set(key, value);
};
