// expect-count: 5
// Every class-body position: static field, instance field, static initialisation block, accessor
// body and async method body.
export class OutboxRepository {
	static readonly missing = new Error("static field initialiser");

	readonly boom = new TypeError("instance field initialiser");

	static {
		if (OutboxRepository.missing === undefined) throw new RangeError("static initialisation block");
	}

	get failure(): unknown {
		return new SyntaxError("accessor body");
	}

	async load(): Promise<never> {
		throw new ReferenceError("async method body");
	}
}
