// Local lookalikes: nothing here is an `effect` binding, so nothing here is a runtime root.
import { ManagedRuntime } from './fake-runtime.ts';
import type { EffectBffRuntime } from './local-types.ts';

const Effect = { runPromise: (value: unknown) => value };

export const boot = () => ManagedRuntime.make({});
void Effect.runPromise(1);

export type RuntimeBox = { readonly inner: EffectBffRuntime<string> };

export const Panel = () => <section data-runtime="managed">ok</section>;
