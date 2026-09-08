// Crash probe: a TSX script with fragments, generics and no process usage at all.
export const List = <Item extends string>({ items }: { readonly items: readonly Item[] }) => (
	<>
		{items.map((item) => (
			<span key={item}>{item}</span>
		))}
	</>
);
