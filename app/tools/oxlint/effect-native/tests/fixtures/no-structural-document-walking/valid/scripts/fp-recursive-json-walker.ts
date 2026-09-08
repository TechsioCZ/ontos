/**
 * False positive reproduction — `scripts/proof-workerd-ssr.mts:282` and
 * `scripts/validate-ultramodern-workspace.mts:2146`.
 *
 * A recursive walk over an arbitrarily shaped JSON tree, looking for release markers wherever they
 * appear. The audit's "Existing patterns to preserve" blesses the *pattern* — "`Array.isArray` in
 * recursive JSON normalization is appropriate" — but the rule honours that blessing only through the
 * single-file `allowPaths` default (`packages/core-runtime/src/actions/repository.ts`), so every other
 * recursive normalizer in the workspace is reported. A value with no static shape has no Schema.
 */
export const findReleaseMarkers = (value: unknown, markers: unknown[] = []): unknown[] => {
	if (Array.isArray(value)) {
		for (const item of value) findReleaseMarkers(item, markers);
		return markers;
	}
	if (!value || typeof value !== 'object') return markers;
	const record = value as Record<string, unknown>;
	if (record['marker'] && typeof record['marker'] === 'object') markers.push(record['marker']);
	for (const nested of Object.values(record)) findReleaseMarkers(nested, markers);
	return markers;
};
