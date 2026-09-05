// expect-count: 3
// Policy boundary: oxlint.config.ts allows successful operational output; audit B3/A6 targets diagnostic logging.
// Static block, private field, `accessor`, getter, async generator, generic arrow, JSX.
declare function Deps(props: { readonly console: unknown; readonly sink: unknown }): unknown;

export class Reporter {
	static {
		console.warn("bootstrap warning");
	}
	#sink = console.error;
	accessor level: string = "info";
	get out(): unknown {
		return console;
	}
	async *stream(rows: readonly string[]): AsyncGenerator<unknown> {
		for (const row of rows) yield console.debug(row);
	}
	render = <T,>(value: T): unknown => <Deps console={value} sink={console} />;
}
