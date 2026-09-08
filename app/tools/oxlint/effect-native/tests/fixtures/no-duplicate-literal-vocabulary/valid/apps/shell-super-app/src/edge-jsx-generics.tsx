// JSX-heavy TSX with a local lookalike `Schema` and no Effect import at all.
const Schema = { Literals: (members: readonly string[]) => members.join('|') };

export function View<T,>(props: { readonly items: readonly T[] }) {
  const a = Schema.Literals(['open', 'closed']);
  const b = Schema.Literals(['closed', 'open']);
  return (
    <>
      <span data-a={a} data-b={b} data-count={props.items.length} />
      {props.items.map((item, index) => (
        <em key={index}>{String(item)}</em>
      ))}
    </>
  );
}
