// expect-count: 4
declare const s: string;
const Generic = <T,>(value: T) => JSON.parse(s) as T;

export function Board() {
	return (
		<>
			<section data-model={JSON.parse(s) as string} {...JSON.parse(s)}>
				{JSON.parse(s) as string}
			</section>
			<Generic<string> value="x" />
		</>
	);
}
