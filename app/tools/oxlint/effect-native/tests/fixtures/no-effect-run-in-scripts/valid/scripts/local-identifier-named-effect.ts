const Effect = { runPromise: async (value: string): Promise<string> => value };

async function collect(): Promise<string> {
	return await Effect.runPromise("not the effect package");
}

void collect;
