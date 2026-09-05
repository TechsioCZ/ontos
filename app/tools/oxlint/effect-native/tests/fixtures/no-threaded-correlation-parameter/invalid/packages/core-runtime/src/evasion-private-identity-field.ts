// expect-count: 2
// A6 evasion: the rule documents class fields as the same declared channel as an interface member,
// but a `#private` field key is a `PrivateIdentifier` and an `abstract accessor` is a
// `TSAbstractAccessorProperty`; both hold request identity on the instance and neither is reported.
export class OperationScope {
	readonly #correlationId: string;

	constructor(seed: string) {
		this.#correlationId = seed;
	}

	get id(): string {
		return this.#correlationId;
	}
}

export abstract class BaseScope {
	abstract accessor traceId: string;
}
