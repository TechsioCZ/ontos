// Test files are out of scope by default (`includeTests: false`): harnesses may build a runtime.
import { Effect, Layer, ManagedRuntime } from 'effect';

declare const TestLayer: Layer.Layer<never>;

const runtime = ManagedRuntime.make(TestLayer);
export const boot = Layer.launch(TestLayer);
export const run = (): Promise<void> => runtime.runPromise(Effect.void);
