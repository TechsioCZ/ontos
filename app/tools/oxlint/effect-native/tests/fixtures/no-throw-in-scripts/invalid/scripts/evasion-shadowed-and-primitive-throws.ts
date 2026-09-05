// expect-count: 9
import { Error as ImportedError } from "./errors.ts";

class TypeError {
	constructor(readonly message: string) {}
}

export function shadowed(kind: number): void {
	if (kind === 0) throw new TypeError("locally declared class, still a throw");
	if (kind === 1) throw new ImportedError("imported constructor, still a throw");
	if (kind === 2) throw new Error();
	if (kind === 3) throw undefined;
	if (kind === 4) throw null;
	if (kind === 5) throw 0;
	try {
		JSON.parse("{}");
	} catch ({ cause }) {
		throw cause;
	}
	throw "top-of-function sentinel";
}

throw new Error("module top-level throw");
