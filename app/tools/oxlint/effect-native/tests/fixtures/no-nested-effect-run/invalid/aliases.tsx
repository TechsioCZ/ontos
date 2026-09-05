// expect-count: 3
import { Effect as Fx, Layer } from "effect";

declare const boot: () => Fx.Effect<number>;
declare const Tag: never;

const run = Fx.runPromise;
const { runSync } = Fx;

export const layer = Layer.effect(Tag, Fx.sync(() => run(boot())));

export const eager = Fx.sync(() => runSync(boot()));

export const computed = Fx.sync(() => Fx["runFork"](boot()));

export const View = () => <div>{String(layer)}</div>;
