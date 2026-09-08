/** Promise-shaped *callback parameters* are third-party continuations, not first-party ports. */
export function withRetry(run: (attempt: number) => Promise<void>): void {
	void run;
}

export const withTimeout = (run: () => Promise<void>) => run;

export class Runner {
	constructor(private readonly run: (attempt: number) => Promise<void>) {}

	start(onDone: () => Promise<void>, ...rest: ReadonlyArray<() => Promise<void>>): void {
		void this.run;
		void onDone;
		void rest;
	}
}

export function withDefault(run: (() => Promise<void>) | undefined = undefined): void {
	void run;
}
