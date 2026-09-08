// expect-count: 1
// Policy boundary: oxlint.config.ts allows successful operational output; audit B3/A6 targets diagnostic logging.
const levels = ["info", "warn"] as const;

export function renderRow(label: string): unknown {
	console.log(`row ${label}`);
	for (const level of levels) console[level](label);
	return <span data-label={label}>{label}</span>;
}

export const renderRows = (labels: readonly string[]): readonly unknown[] => {
	labels.forEach(console.warn);
	return labels.map((label) => renderRow(label));
};
