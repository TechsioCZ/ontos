#!/usr/bin/env node
import { Effect, Layer } from 'effect';

declare const AllDependenciesLive: Layer.Layer<never>;
declare const ScriptLive: Layer.Layer<never>;

// `scripts/**` is a startup root: one deliberate outer boundary is blessed.
export const layer = ScriptLive.pipe(
  Layer.provide(AllDependenciesLive),
  Layer.tapErrorCause(Effect.logError),
  Layer.orDie,
);
