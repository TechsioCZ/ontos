import { Effect, Layer } from 'effect';
import * as Stream from 'effect/Stream';
import { Layer as NotEffectLayer } from 'effect-native-helpers';
import { Layer as LocalLayer } from './local-layer.ts';

declare const Base: Layer.Layer<never>;
declare const source: Stream.Stream<number>;

// `orDie` on some other namespace, or on a `Layer` that is not effect's.
export const effectOrDie = Effect.orDie(Effect.succeed(1));
export const streamOrDie = Stream.orDie(source);
export const lookalikeModule = NotEffectLayer.orDie(Base);
export const localModule = LocalLayer.orDie(Base);
export const stillTransparent = Base.pipe(Layer.provide(Base));
