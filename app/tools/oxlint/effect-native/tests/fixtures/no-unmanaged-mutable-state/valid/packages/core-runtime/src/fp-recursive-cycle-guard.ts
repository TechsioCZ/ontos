// Regression fixture for a confirmed false positive.
//
// Real site: packages/core-runtime/src/actions/repository.ts:138 and :146, where
// `normalizeForHash(value, new WeakSet())` passes an *ephemeral, per-call* visited-set into a
// recursive canonicaliser. The WeakSet is never bound to a module variable, never escapes the
// call, carries no defect cause, asserts no provenance and holds no UI state: it is the standard
// cycle guard of a recursive normaliser. The audit blesses exactly this shape under
// "Existing patterns to preserve" ("`Array.isArray` in recursive JSON normalization is
// appropriate") and D tier ("native array/object operations where Effect collection APIs add no
// semantic value"), and none of A4/B4/C3 lists these two lines as evidence.
//
// The rule's own remediation text ("declare it on the error contract", "make that a branded
// Schema or a Context service", "use `Effect.cached` / `Cache` owned by a `Layer`") has no
// meaning here — there is no Effect replacement for a recursion visited-set inside a pure,
// synchronous hash function.
import { createHash } from 'node:crypto';

type Canonical = readonly [string, unknown];

const normalizeForHash = (value: unknown, seen: WeakSet<object>): Canonical => {
	if (Array.isArray(value)) {
		if (seen.has(value)) throw new TypeError('cyclic value');
		seen.add(value);
		const normalized = value.map((item) => normalizeForHash(item, seen));
		seen.delete(value);
		return ['array', normalized];
	}
	if (typeof value === 'object' && value !== null) {
		if (seen.has(value)) throw new TypeError('cyclic value');
		seen.add(value);
		const entries = Object.entries(value).map(([key, item]) => [key, normalizeForHash(item, seen)] as const);
		seen.delete(value);
		return ['object', entries];
	}
	return ['scalar', value];
};

export const computeCanonicalValueHash = <Value>(value?: Value): string =>
	createHash('sha256').update(JSON.stringify(normalizeForHash(value, new WeakSet()))).digest('hex');

export const computeEnvelopeHash = (envelope: Readonly<Record<string, unknown>>): string =>
	createHash('sha256').update(JSON.stringify(normalizeForHash(envelope, new WeakSet()))).digest('hex');
