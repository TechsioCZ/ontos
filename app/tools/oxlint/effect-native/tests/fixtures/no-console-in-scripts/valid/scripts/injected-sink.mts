// A shadowing binding is never the ambient console: parameter, local, option bag, property key.
interface Reporter {
	readonly log: (message: string) => void;
	readonly error: (message: string) => void;
}

export function withInjectedSink(console: Reporter, message: string): void {
	console.log(message);
	console.error(message);
}

export function withLocalSink(options: { readonly console: Reporter }): void {
	const console = options.console;
	console.log("local sink");
	options.console.error("through the option bag");
}

export const scaffoldDefaults = { console: false } as const;
