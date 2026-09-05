// expect-count: 1
// Same defect through an `interface` declaration, in a TSX file.
declare const s: string;

interface JSON {
	readonly document: string;
}

export function Panel() {
	const model = JSON.parse(s) as JSON;
	return <span>{model.document}</span>;
}
