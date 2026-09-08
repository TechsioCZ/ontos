// expect-count: 2
// Policy boundary: oxlint.config.ts allows successful operational output; audit B3/A6 targets diagnostic logging.
// Indirect call forms: tagged template, sequence-expression unwrapping, `.bind`, reflective access.
export function emit(message: string): void {
	console.log`tagged ${message}`;
	(0, console.error)(message);
	const write = console.warn.bind(console);
	write(message);
	Reflect.get(console, "log")(message);
}
