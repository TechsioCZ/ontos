import { Context } from 'effect';
import * as Crypto from 'effect/Crypto';
import { gen, provideService as supply } from 'effect/Effect';
import type { Effect } from 'effect/Effect';
import { effect as buildLayer } from 'effect/Layer';

class Output extends Context.Service<Output, { readonly send: () => Effect<Uint8Array> }>()('@fixture/Output') {}

export const live = buildLayer(Output, gen(function* constructOutput() {
  const crypto = yield* Crypto.Crypto;
  return { send: () => supply(Crypto.randomBytes(4), Crypto.Crypto, crypto) };
}));
