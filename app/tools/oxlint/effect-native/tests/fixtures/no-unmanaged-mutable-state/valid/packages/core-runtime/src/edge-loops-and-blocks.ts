// Loop bindings, block-scoped scratch state and ambient declarations are not module state.
declare let ambientToken: string;

for (let index = 0; index < 3; index += 1) {
	globalThis.console.log(index);
}

{
	let scratch = 0;
	scratch += 1;
	globalThis.console.log(scratch);
}

export const token = (): string => ambientToken;

export const eachKey = (source: Readonly<Record<string, string>>): readonly string[] => {
	const keys: string[] = [];
	for (const key in source) keys.push(key);
	return keys;
};
