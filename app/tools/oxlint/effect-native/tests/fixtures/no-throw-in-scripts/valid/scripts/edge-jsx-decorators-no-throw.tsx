/** TSX with JSX, class members, generators and native array ops (D tier) — no throw statement anywhere. */
export const Row = ({ label }: { readonly label: string }) => <li className="row">{label}</li>;

export class Report {
	accessor title: string = "report";

	*rows(labels: readonly string[]): Generator<string> {
		for (const label of labels.filter((entry) => entry.length > 0).map((entry) => entry.trim())) yield label;
	}

	render(labels: readonly string[]): JSX.Element {
		return (
			<ul>
				{labels.map((label) => (
					<Row key={label} label={label} />
				))}
			</ul>
		);
	}
}
