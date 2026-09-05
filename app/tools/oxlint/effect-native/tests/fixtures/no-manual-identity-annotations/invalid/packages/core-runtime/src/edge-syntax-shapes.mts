// expect-count: 6
// Coverage lock for syntax positions: `.mts`, decorated class members, static initialisers, getters,
// async generators, curried arrows and accessor-shaped annotation keys must all stay reported.
import * as Effect from 'effect/Effect';

declare const dec: (...args: readonly unknown[]) => any;
declare const identity: {
	correlationId: string;
	readKey: string;
	actionKey: string;
	tenantId: string;
	invocationId: string;
};

@dec
export class Handler {
	// 1: static initialiser, data-first `withSpan`.
	static readonly traced = Effect.withSpan(Effect.void, 'Handler.run', {
		attributes: { correlationId: identity.correlationId },
	});

	// 2: decorated method, `annotateLogsScoped`.
	@dec
	run(): unknown {
		return Effect.annotateLogsScoped({ readKey: identity.readKey });
	}

	// 3: getter, `annotateSpans`.
	get spanned(): unknown {
		return Effect.annotateSpans(Effect.void, { actionKey: identity.actionKey });
	}
}

// 4: async generator body.
export async function* stream(): AsyncGenerator<unknown> {
	yield Effect.annotateLogs(Effect.void, { tenantId: identity.tenantId });
}

// 5: nested arrow body.
export const curried = () => () => Effect.annotateLogs(Effect.void, { invocationId: identity.invocationId });

// 6: accessor-shaped annotation property.
export const accessorKey = Effect.annotateLogs(Effect.void, {
	get correlationId(): string {
		return identity.correlationId;
	},
});
