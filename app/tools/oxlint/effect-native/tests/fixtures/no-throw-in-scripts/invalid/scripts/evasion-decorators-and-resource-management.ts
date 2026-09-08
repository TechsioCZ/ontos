// expect-count: 4
function audited(value: unknown, context: ClassMethodDecoratorContext): void {
	void value;
	void context;
}

export class Migration {
	accessor label: string = "";

	@audited
	run(): void {
		throw new Error("migration failed");
	}

	dispose(): void {
		using handle = { [Symbol.dispose]: () => undefined };
		void handle;
		throw new Error("dispose failed");
	}
}

export async function main(chunks: AsyncIterable<string>): Promise<void> {
	await using scope = { [Symbol.asyncDispose]: async () => undefined };
	void scope;
	for await (const chunk of chunks) {
		if (chunk === "") throw new SyntaxError("empty chunk");
	}
	outer: {
		throw new Error("labeled block");
	}
}
