// expect-count: 4
import { Effect as E, Layer as L } from "effect";
import * as Lyr from "effect/Layer";

interface AuthenticationService {
  readonly verify: () => E.Effect<void>;
}

// 1: `Layer` imported from `effect` under an alias.
export const bootAliased = (authenticationLayer: L.Layer<AuthenticationService>) => authenticationLayer;

// 2: submodule namespace import bound to a different local name.
export const bootNamespaced = (moduleStateLayer: Lyr.Layer<AuthenticationService>) => moduleStateLayer;

// 3: inline operation record whose members return `Effect` through an aliased namespace.
export const withOperations = (operations: {
  readonly list: () => E.Effect<readonly string[]>;
  readonly get: (id: string) => E.Effect<string>;
}) => operations;

// 4: the service itself.
export const bind = (authentication: AuthenticationService) => authentication;
