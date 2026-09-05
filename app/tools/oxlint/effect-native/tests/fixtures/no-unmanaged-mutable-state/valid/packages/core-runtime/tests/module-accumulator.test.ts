// Tests are excluded by default (`includeTests: false`): module-level accumulators and WeakMaps
// here are scaffolding, not production state.
const observed = new Map<string, number>();
const seenObjects = new WeakSet<object>();
let currentCase = 0;

export const record = (name: string, value: object): void => {
	observed.set(name, currentCase);
	seenObjects.add(value);
	currentCase += 1;
};
