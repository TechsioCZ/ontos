import { Effect, Layer } from "effect";
import { HttpApiClient } from "effect/unstable/http";

declare const ContactsApi: never;
declare const InMemoryHttpClient: Layer.Layer<never>;

export const listContacts = Effect.gen(function* () {
	const client = yield* HttpApiClient.make(ContactsApi, { baseUrl: "http://in-memory" });
	return yield* client.contacts.list();
}).pipe(Effect.provide(InMemoryHttpClient));

export const Probe = () => <span>probe</span>;
