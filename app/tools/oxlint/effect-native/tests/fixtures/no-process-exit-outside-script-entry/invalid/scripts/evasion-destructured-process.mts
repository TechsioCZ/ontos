// expect-count: 1
// Evasion probe: the exit function taken off the global `process` object by destructuring
// (`const { argv, exit } = process` is a common Node script idiom), then called from a helper.
const { exit } = process;

export const bail = (message: string): void => {
	console.error(message);
	exit(1);
};
