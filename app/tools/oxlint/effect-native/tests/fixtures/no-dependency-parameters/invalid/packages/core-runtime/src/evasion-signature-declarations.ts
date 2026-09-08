// expect-count: 6
import { Effect } from "effect";

interface ContactsGateway {
  readonly list: () => Effect.Effect<string>;
}

// 1: fully parenthesised annotation.
export const parenthesised = (gateway: ((ContactsGateway))) => gateway;
// 2: nested union / intersection members.
export const nestedUnion = (gateway: (ContactsGateway | undefined) | null) => gateway;
// 3: constructor type.
export const constructed = (factory: new (gateway: ContactsGateway) => object) => factory;
// 4-5: construct and call signatures of a port declaration.
export interface GatewayCtor {
  new (gateway: ContactsGateway): object;
  (gateway: ContactsGateway): void;
}
// 6: overload declaration.
export declare function overloaded(gateway: ContactsGateway): void;
export declare function overloaded(label: string): void;
