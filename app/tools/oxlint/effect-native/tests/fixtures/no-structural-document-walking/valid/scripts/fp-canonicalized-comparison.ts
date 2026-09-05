/**
 * False positive reproduction — `scripts/validate-ultramodern-workspace.mts:2169` (`sameJson`).
 *
 * Both operands are canonicalized first: object keys are sorted, so the diagnostic's stated rationale
 * ("the verdict depends on key insertion order and on how `undefined` is dropped") is factually false
 * at this site. This is a deliberate stable-key deep-equality helper in a build validation script —
 * D tier "native object operations where Effect collection APIs add no semantic value".
 */
const canonicalizeJson = (value: unknown): unknown => {
	if (Array.isArray(value)) return value.map(canonicalizeJson);
	if (value === null || typeof value !== 'object') return value;
	return Object.fromEntries(
		Object.keys(value as Record<string, unknown>)
			.toSorted()
			.map((key) => [key, canonicalizeJson((value as Record<string, unknown>)[key])]),
	);
};

export const sameJson = (actual: unknown, expected: unknown): boolean =>
	JSON.stringify(canonicalizeJson(actual)) === JSON.stringify(canonicalizeJson(expected));
