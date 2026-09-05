import { Effect } from "effect";

// A local generic type that merely happens to be called `Layer`.
interface Layer<Value> {
  readonly value: Value;
}
interface ContactRow {
  readonly id: string;
}
type Events = { readonly [K in `on${"Save" | "Close"}`]?: () => void };
type Unwrap<T> = T extends { readonly row: infer Row } ? Row : never;

export const Row = ({ id }: ContactRow) => <li>{id}</li>;
export const Wrapped = (layer: Layer<ContactRow>) => <li>{layer.value.id}</li>;
export const Events = (events: Events, at: Date, index: Map<string, ContactRow>) => [events, at, index];
export const Unwrapped = (row: Unwrap<{ readonly row: ContactRow }>, key: `contact-${string}`) => [row, key];

// A record of plain callbacks is an ordinary handler bag, not a service.
export const List = <Item,>(props: {
  readonly items: readonly Item[];
  readonly onSelect: (id: string) => void;
  readonly onClose: () => void;
}) => <ul>{props.items.map((item, index) => <li key={index}>{String(item)}</li>)}</ul>;

// The target pattern is invisible to this rule.
export const load = Effect.gen(function* () {
  const rows: readonly ContactRow[] = [];
  return rows;
});
