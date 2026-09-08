// expect-count: 6
import { Effect } from "effect";

interface ContactsGateway {
  readonly list: () => Effect.Effect<string>;
}
// 1: the port declared as a bare function type.
type Handler = (gateway: ContactsGateway) => ContactsGateway;

// 2: `satisfies` does not change the parameter.
export const asSatisfies = ((gateway: ContactsGateway) => gateway) satisfies Handler;
// 3: nor does an `as` cast.
export const asCast = ((gateway: ContactsGateway) => gateway) as Handler;
// 4: nested arrow body.
export const curried = (label: string) => (gateway: ContactsGateway) => [label, gateway];
// 5: immediately invoked.
export const invoked = ((gateway: ContactsGateway) => gateway)({} as ContactsGateway);
// 6: default export.
export default (gateway: ContactsGateway) => gateway;

export const Panel = () => <button onClick={() => asCast({} as ContactsGateway)}>ok</button>;
