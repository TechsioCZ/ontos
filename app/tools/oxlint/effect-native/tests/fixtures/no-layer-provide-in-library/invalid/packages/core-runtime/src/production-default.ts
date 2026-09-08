// expect-count: 1
import { Layer } from "effect";
export const Prepared = Layer.provide(FeatureLive, DependencyLive);
