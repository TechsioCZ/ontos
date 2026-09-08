// expect-count: 8
// A TypeScript type wrapper around the annotation record hides every identity from the rule:
// `as const` / `satisfies` / `as T` / `<T>x` / `x!` all wrap the ObjectExpression in a TS node, and the
// rule only inspects arguments whose type is literally `ObjectExpression`. `as const` in particular is
// idiomatic in this codebase, so a single token silently disables A6 enforcement at a call site.
import { Effect } from 'effect';

declare const identity: {
	correlationId: string;
	tenantId: string;
	actionKey: string;
	readKey: string;
	principalId: string;
};

// 1: `as const` on a data-first annotation record.
export const asConst = Effect.annotateLogs(Effect.logInfo('x'), {
	correlationId: identity.correlationId,
} as const);

// 2: `satisfies` on a data-first annotation record.
export const satisfiesRecord = Effect.annotateLogs(Effect.void, {
	tenantId: identity.tenantId,
} satisfies Record<string, string>);

// 3: `as T` on a data-last annotation record.
export const asRecord = Effect.annotateLogs({ actionKey: identity.actionKey } as Record<string, string>);

// 4: angle-bracket type assertion on a data-last annotation record.
export const angleBracket = Effect.annotateLogs(<Record<string, string>>{ readKey: identity.readKey });

// 5: non-null assertion on a data-first annotation record.
export const nonNull = Effect.annotateLogs(Effect.void, { principalId: identity.principalId }!);

// 6: `as const` on the span `attributes` record.
export const attributesAsConst = Effect.void.pipe(
	Effect.withSpan('SpiceDB.checkActionPermission', {
		attributes: { correlationId: identity.correlationId } as const,
	}),
);

// 7: `as const` on the whole span options object.
export const optionsAsConst = Effect.void.pipe(
	Effect.withSpan('SpiceDB.checkActionPermission', {
		attributes: { tenantId: identity.tenantId },
	} as const),
);

// 8: `as const` on the literal key of the two-argument key/value form.
export const keyAsConst = Effect.annotateCurrentSpan('correlationId' as const, identity.correlationId);
