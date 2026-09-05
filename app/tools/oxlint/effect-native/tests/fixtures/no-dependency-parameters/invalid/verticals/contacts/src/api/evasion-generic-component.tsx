// expect-count: 3
import { Effect } from "effect";

interface ContactsGateway {
  readonly list: () => Effect.Effect<readonly string[]>;
}

// 1: generic arrow component whose props bag carries a gateway.
export const List = <Item,>(props: {
  readonly items: readonly Item[];
  readonly gateway: ContactsGateway;
}) => <ul>{props.items.map((item, index) => <li key={index}>{String(item)}</li>)}</ul>;

// 2: destructured props with a rest element.
export const Panel = ({ gateway, ...rest }: { readonly gateway: ContactsGateway; readonly title: string }) => (
  <section>{rest.title}</section>
);

// 3: rest parameter of gateways.
export const bindAll = (...gateways: readonly ContactsGateway[]) => gateways;
