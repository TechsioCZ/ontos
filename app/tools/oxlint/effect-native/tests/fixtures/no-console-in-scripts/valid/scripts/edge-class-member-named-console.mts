// A class member named `console` is a name, not a reference — exactly like the `{ console: … }`
// property key the rule already exempts.
export class ScaffoldOptions {
	console = false;
	report(): void {}
}

export class Sink {
	console(): void {}
	get console2(): number {
		return 1;
	}
}
