// expect-count: 7
// A4: import-shape coverage — aliases, root namespace, submodule namespace, direct member import,
// computed access, optional chaining and point-free `pipe` combinators.
import { Effect as E, pipe } from 'effect';
import * as Eff from 'effect';
import * as Layer from 'effect/Layer';
import { gen } from 'effect/Effect';

import { configurationError } from './errors.ts';

declare const program: E.Effect<number, Error>;
declare const tag: unknown;

export const aliased = E.sync(() => {
  throw new TypeError('unsupported gateway algorithm');
});

export const rootNamespace = Eff.Effect.gen(function* () {
  yield* Eff.Effect.log('resolving gateway issuer');
  throw configurationError('OIDC_ISSUER is missing');
});

export const directMember = gen(function* () {
  yield* E.log('decoding');
  throw new Error('unreachable');
});

export const layerBody = Layer.effect(
  tag as never,
  E.sync(() => {
    throw new Error('cannot build the issuer');
  }),
);

export const computed = E['sync'](() => {
  throw new Error('computed member access');
});

export const optional = E?.sync?.(() => {
  throw new Error('optional chaining');
});

export const pointFree = pipe(
  program,
  E.catchAll((error: Error) => {
    throw error;
  }),
);
