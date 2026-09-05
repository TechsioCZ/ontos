// expect-count: 7
// Class bodies: fields, static blocks, accessors, private methods and computed keys.
declare const v: unknown;

export class Codec {
	serialize = JSON.stringify;
	static dump = JSON.stringify;
	static {
		void JSON.stringify(v);
	}
	get encoded(): string {
		return JSON.stringify(v);
	}
	#hidden(): string {
		return JSON.stringify(v);
	}
	[JSON.stringify({ marker: 1 })](): number {
		return 1;
	}
	async *stream(): AsyncGenerator<string> {
		yield JSON.stringify(v);
	}
}
