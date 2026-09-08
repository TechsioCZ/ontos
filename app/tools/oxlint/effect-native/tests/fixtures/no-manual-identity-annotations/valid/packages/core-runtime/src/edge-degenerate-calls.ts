// Degenerate and hostile call shapes must not crash the rule and must not report: no arguments,
// spread arguments, decorators, a TS namespace, computed non-literal keys, numeric keys, `__proto__`
// (the identity lookup uses a Map, so no prototype pollution) and an empty annotation record.
import { Effect } from 'effect';

declare const dec: (...args: readonly unknown[]) => any;
declare const spreadArgs: readonly [unknown, Record<string, unknown>];
declare const computedKey: () => string;

export namespace Legacy {
	export const version = 1;
}

@dec
export class Decorated {
	@dec
	method(@dec _parameter: number): number {
		return 1;
	}
}

export const noArguments = Effect.annotateLogs();
export const spreadArguments = Effect.annotateLogs(...spreadArgs);
export const spanNoArguments = Effect.withSpan();
export const spanNameOnly = Effect.withSpan('Contacts.read');
export const spanWithoutAttributes = Effect.withSpan('Contacts.read', { kind: 'server', root: true });
export const emptyRecord = Effect.annotateLogs(Effect.void, {});
export const hostileKeys = Effect.annotateLogs(Effect.void, {
	__proto__: null,
	42: 1,
	[computedKey()]: 2,
	[Symbol.iterator]: 3,
});
