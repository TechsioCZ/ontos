// expect-count: 4
import { Effect } from "effect";

interface ContactsGateway {
  readonly list: () => Effect.Effect<readonly string[]>;
}

// 1: inline record of Effect-returning operations (symbol-slotted operation record).
export const withOperations = (operations: {
  readonly list: () => Effect.Effect<readonly string[]>;
  readonly get: (id: string) => Effect.Effect<string>;
}) => operations;

// 2: option bag hiding a gateway.
export const renderList = (props: {
  readonly title: string;
  readonly gateway: ContactsGateway;
}) => <div>{props.title}</div>;

// 3: destructured option bag declared as a same-module interface.
export interface PanelProps {
  readonly heading: string;
  readonly contactsGateway: ContactsGateway;
}
export const Panel = ({ heading, contactsGateway }: PanelProps) => <section>{heading}</section>;

// 4: arrow parameter typed by a dependency name.
export const bind = (gateway: ContactsGateway) => gateway;
