// Same member names on things that are not Effect: a DI container, a React provider, a local shim.
import { Layer } from "effect";
import { container } from "./container.ts";

declare const ConfigLive: Layer.Layer<never, never, never>;

const Effect = {
  provide: (value: string) => value,
  provideService: (value: string) => value,
};

export function Providers(): unknown {
  container.provide("token", 1);
  container.provideService("token", 1);
  const shimmed = Effect.provide("still not the effect namespace");
  const layered = ConfigLive.pipe(Layer.provide(ConfigLive));
  return <div data-value={shimmed} data-layer={String(layered)} />;
}
