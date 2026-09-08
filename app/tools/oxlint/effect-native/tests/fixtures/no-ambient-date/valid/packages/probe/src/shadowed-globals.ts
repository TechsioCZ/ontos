/** Local bindings that merely share a global's name must never report. */
class Date {
	readonly iso: string;

	constructor(iso: string) {
		this.iso = iso;
	}
}

const performance = { now: (): number => 0 };
const process = { hrtime: (): number => 0 };

export function build(): string {
	const instance = new Date("2026-01-01T00:00:00Z");
	const elapsed = performance.now();
	const ticks = process.hrtime();
	return `${instance.iso}:${elapsed}:${ticks}`;
}
