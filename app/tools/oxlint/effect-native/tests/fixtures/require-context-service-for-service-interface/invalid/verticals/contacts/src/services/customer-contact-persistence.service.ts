// expect-count: 3
import { Effect as Eff } from 'effect';
import * as Layer from 'effect/Layer';

/** Aliased Effect namespace import still resolves. */
export interface CustomerContactPersistenceService {
  readonly load: (id: string) => Eff.Effect<string, Error>;
}

/** Type-literal alias form. */
export type CustomerContactSearchGateway = {
  readonly search: (query: string) => Eff.Effect<readonly string[], Error>;
};

/** Call signature form. */
export interface CustomerContactResolverPort {
  (id: string): Eff.Effect<string>;
}

/** Not a service seam: an options bag, and a record with no effectful member. */
export interface CustomerContactOptions {
  readonly load: (id: string) => Eff.Effect<string>;
}
export interface CustomerContactRowStore {
  readonly rows: readonly string[];
}

/** `Layer` is imported but never used to construct anything, so the module is still untagged. */
export type ContactsLayer = Layer.Layer<never>;
