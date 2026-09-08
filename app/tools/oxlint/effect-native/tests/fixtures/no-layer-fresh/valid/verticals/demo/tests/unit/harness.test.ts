import { Layer } from 'effect';

declare const TestLive: Layer.Layer<never>;

// Tests may still build isolated graphs — with distinct tags and root composition, not `Layer.fresh`.
export const harness = Layer.mergeAll(TestLive);
export const scoped = Layer.provide(TestLive, TestLive);
