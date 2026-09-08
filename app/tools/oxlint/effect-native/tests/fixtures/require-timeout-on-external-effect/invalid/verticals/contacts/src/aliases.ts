// expect-count: 4
import { Effect as Eff } from 'effect';
import * as EffectNs from 'effect';
import * as Fx from 'effect/Effect';
import { tryPromise as bridge } from 'effect/Effect';

declare const load: () => Promise<string>;

const fail = () => new Error('load failed');

export const aliased = Eff.tryPromise({ catch: fail, try: load });
export const barrel = EffectNs.Effect.tryPromise({ catch: fail, try: load });
export const submodule = Fx.tryPromise({ catch: fail, try: load });
export const bare = bridge({ catch: fail, try: load });
