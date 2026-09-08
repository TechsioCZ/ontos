import { Layer, ManagedRuntime } from 'effect';

declare const AppLive: Layer.Layer<never>;

// D tier: `Layer.orDie` at a deliberate outer startup boundary stays untouched by this rule.
export const runtime = ManagedRuntime.make(Layer.orDie(AppLive));
