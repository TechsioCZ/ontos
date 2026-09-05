// Type positions and label names that merely spell `console`.
declare const sink: { readonly log: (message: string) => void };
let mirror: typeof console | undefined;
mirror = undefined;
void mirror;

export function loop(): void {
	console: for (let index = 0; index < 1; index += 1) {
		if (index > 0) break console;
		continue console;
	}
	sink.log("ok");
}

export interface Deps {
	console: typeof sink;
}
