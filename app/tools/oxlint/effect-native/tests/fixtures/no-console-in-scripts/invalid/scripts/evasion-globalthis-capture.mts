// B3/A6: `const c = console` reports and `globalThis.console.log(...)` reports, but capturing the
// same object through the container global silences the whole file.
const sink = globalThis.console;

export function emit(message: string): void {
	sink.log(message);
	sink.error(message);
}
