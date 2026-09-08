// expect-count: 1
import { Layer } from 'effect';

declare const SeedLive: Layer.Layer<never>;

export const seeded = SeedLive.pipe(Layer.fresh);
