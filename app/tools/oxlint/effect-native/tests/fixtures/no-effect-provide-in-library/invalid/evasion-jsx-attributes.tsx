// expect-count: 2
// A provide hidden in a JSX attribute value and in a JSX spread object still erases R.
import { Effect } from "effect";

declare const RequirementsLayer: never;
declare const program: Effect.Effect<string, never, never>;
declare const Panel: (props: { readonly run: unknown; readonly fallback?: unknown }) => unknown;

export function Screen(): unknown {
  return (
    <Panel
      run={program.pipe(Effect.provide(RequirementsLayer))}
      {...{ fallback: Effect.provide(program, RequirementsLayer) }}
    />
  );
}
