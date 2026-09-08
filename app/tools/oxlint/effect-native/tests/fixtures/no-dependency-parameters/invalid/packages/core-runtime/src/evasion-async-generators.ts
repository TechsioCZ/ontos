// expect-count: 5
import { Effect } from "effect";

interface ContactsGateway {
  readonly list: () => Effect.Effect<string>;
}

// 1-5: async, generator and async-generator functions hide dependencies exactly like sync ones.
export async function loadAll(gateway: ContactsGateway) {
  return gateway;
}
export function* iterate(gateway: ContactsGateway) {
  yield gateway;
}
export async function* stream(gateway: ContactsGateway) {
  yield gateway;
}
export const loadOne = async (gateway: ContactsGateway) => gateway;
export const traced = Effect.fn("run")(function* (gateway: ContactsGateway) {
  return gateway;
});
