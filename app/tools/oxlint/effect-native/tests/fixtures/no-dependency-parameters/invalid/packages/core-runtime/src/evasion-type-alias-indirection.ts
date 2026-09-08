// expect-count: 3
import { Effect, Layer } from "effect";

interface ContactsGateway {
  readonly list: () => Effect.Effect<string>;
}
interface AuthenticationService {
  readonly verify: () => void;
}
declare const CoreDatabase: { readonly Service: { readonly query: () => Effect.Effect<string> } };

// A same-module alias renames the dependency; it does not remove it from the graph.
// `packages/core-runtime/tests/integration/module-state-gate.test.ts:23` already writes
// `type DatabaseService = (typeof CoreDatabase)['Service']`, so this indirection is native here.
type Database = (typeof CoreDatabase)["Service"];
type AppLayer = Layer.Layer<AuthenticationService>;
type Contacts = ContactsGateway;

// 1-3: the same three dependencies as before, hidden behind aliases.
export const makeRuntime = (database: Database, layer: AppLayer, contacts: Contacts) => [database, layer, contacts];
