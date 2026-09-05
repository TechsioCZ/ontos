// Function-local mutable state is ordinary computation, not module state.
export const summarise = (rows: readonly string[]): string => {
	let total = 0;
	const seen = new Set<string>();
	const parts: string[] = [];
	const byRow: Record<string, number> = {};
	for (const row of rows) {
		if (seen.has(row)) continue;
		seen.add(row);
		parts.push(row);
		byRow[row] = total;
		total += 1;
	}
	return `${String(total)}:${parts.join(",")}:${String(Object.keys(byRow).length)}`;
};

export function makeCounter(): () => number {
	let value = 0;
	return () => {
		value += 1;
		return value;
	};
}
