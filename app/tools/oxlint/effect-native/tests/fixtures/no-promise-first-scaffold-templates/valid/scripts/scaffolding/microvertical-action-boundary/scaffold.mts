/** Audit "Existing patterns to preserve" / D tier: a template may emit every blessed shape. */
export const renderRuntimeRoot = (name: string): string => `import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import { ManagedRuntime } from 'effect';

const ${name}Layer = Layer.mergeAll(${name}ClientLayer, TracingLayer);

// Layer.orDie at the deliberate outer startup boundary, with the typed cause logged first.
export const ${name}Runtime = ManagedRuntime.make(
  ${name}Layer.pipe(Layer.tapErrorCause(Effect.logError), Layer.orDie),
);

// JSON.stringify inside an external test fixture API that requires a body string.
export const ${name}FixtureBody = (payload: unknown) => ({ body: JSON.stringify(payload) });

// Native array operations where Effect collection APIs add no semantic value.
export const summarise${name} = (rows: ReadonlyArray<{ readonly total: number }>) =>
  rows.map((row) => row.total).filter((total) => total > 0);
`;
