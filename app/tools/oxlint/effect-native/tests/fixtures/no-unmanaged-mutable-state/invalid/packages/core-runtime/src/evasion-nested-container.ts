// expect-count: 1
// Evasion: one level of nesting. `registry` is a module-level object literal whose inner array and
// Map are mutated on every call, so the process-global accumulator survives every request.
const registry = {
	byKey: new Map<string, string>(),
	entries: [] as string[],
};

export const add = (key: string): void => {
	registry.entries.push(key);
	registry.byKey.set(key, key);
};

export const size = (): number => registry.entries.length;
