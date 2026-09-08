declare function logged(target: unknown, key: string): void;

export class Panel<T> {
	@logged
	render(value: T): unknown {
		const rows = [value] satisfies readonly T[];
		return <ul>{rows.map((row, index) => <li key={index}>{String(row)}</li>)}</ul>;
	}
}
