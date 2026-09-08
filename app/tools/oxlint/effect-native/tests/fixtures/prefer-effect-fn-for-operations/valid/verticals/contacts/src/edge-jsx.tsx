import { Effect } from "effect";

declare const useState: <S>(initial: S) => readonly [S, (next: S) => void];

/** Generic arrow component in TSX. */
export const List = <T,>(props: { readonly items: readonly T[] }) => (
	<ul>
		{props.items.map((item, index) => (
			<li key={index}>{String(item)}</li>
		))}
	</ul>
);

export const Panel = (props: { readonly title?: string }) => {
	const [open, setOpen] = useState(false);
	return (
		<>
			<button type="button" onClick={() => setOpen(!open)}>
				{props.title ?? "untitled"}
			</button>
			{open ? <List items={[1, 2, 3]} /> : null}
		</>
	);
};

/** A zero-argument boot thunk carries no arguments to annotate. */
export const boot = () =>
	Effect.gen(function* () {
		yield* Effect.log("boot");
	});
