// expect-count: 7
// Every JSX position that can carry hand-owned serialization.
declare const v: Record<string, unknown>;
declare const items: readonly unknown[];
declare const cond: boolean;

export function Panel() {
	return (
		<>
			<div data-payload={JSON.stringify(v)} {...{ title: JSON.stringify(v) }}>
				{JSON.stringify(v)}
				{cond ? JSON.stringify(v) : null}
				{items.map((item) => (
					<span key={JSON.stringify(item)}>{String(item)}</span>
				))}
			</div>
			<meta content={`${JSON.stringify(v)}`} />
		</>
	);
}

export const Generic = <T,>(value: T) => <span>{JSON.stringify(value)}</span>;
