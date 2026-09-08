/** `scripts/local-environment-values.mts` builds a *total* map of the values it wrote itself. */
const existingValues = (lines: readonly string[]): Readonly<Record<string, string>> => {
	const values: Record<string, string> = {};
	for (const line of lines) {
		const [key, ...rest] = line.split('=');
		if (key !== undefined && rest.length > 0) values[key] = rest.join('=');
	}
	return values;
};

/** JSON parsing helpers keep `unknown` values. */
const asObject = (raw: unknown): Readonly<Record<string, unknown>> => raw as Readonly<Record<string, unknown>>;

export const summarise = (lines: readonly string[], raw: unknown): ReadonlyMap<string, string> =>
	new Map(Object.entries({ ...existingValues(lines), ...asObject(raw) }).map(([key, value]) => [key, String(value)]));
