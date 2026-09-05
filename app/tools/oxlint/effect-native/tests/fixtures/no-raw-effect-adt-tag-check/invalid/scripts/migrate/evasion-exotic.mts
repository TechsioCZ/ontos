// expect-count: 6
import { Effect, Exit } from 'effect';

export async function* stream(exits: readonly Exit.Exit<number>[]): AsyncGenerator<string> {
	for await (const exit of exits) {
		if (exit._tag === 'Failure') yield 'failed';
		yield exit._tag === 'Success' ? 'ok' : 'other';
	}
}

const probe = (exit: Exit.Exit<number>): string => {
	switch (true) {
		case exit._tag === 'Failure':
			return 'failed';
		default:
			return 'ok';
	}
};

export class Runner {
	static {
		queueMicrotask(() => {
			const exit = Exit.succeed(1);
			if (exit._tag === 'Success') Effect.runSync(Effect.void);
		});
	}

	async run(exit: Exit.Exit<number>): Promise<string> {
		outer: for (const _candidate of [exit]) {
			if (exit?.['_tag'] === 'Failure') break outer;
		}
		return probe(exit);
	}
}

export const firstFailed = await Promise.resolve(Exit.succeed(1)).then((exit) => exit._tag === 'Success');
