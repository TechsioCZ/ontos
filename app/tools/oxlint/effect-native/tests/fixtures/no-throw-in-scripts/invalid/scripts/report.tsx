// expect-count: 2
export function renderRow(label: string | undefined): unknown {
	if (label === undefined) {
		throw new Error("label is required");
	}
	return <span data-label={label}>{label}</span>;
}

export function renderAll(labels: readonly string[]): readonly unknown[] {
	if (labels.length === 0) throw new RangeError("no labels");
	return labels.map((label) => renderRow(label));
}
