// JSX shapes that resemble the tracked members but are JSX nodes, plus generic arrows and fragments.
import { Effect } from 'effect';

const Layer = { Root: (props: { readonly title: string }) => <b>{props.title}</b> };
const ManagedRuntime = { Provider: (props: { readonly children?: unknown }) => <>{props.children}</> };

export const identity = <T,>(value: T): T => value;

declare const program: Effect.Effect<number>;

export const Page = () => (
  <ManagedRuntime.Provider>
    <Layer.Root title="launch" />
    <div data-make="make" aria-label={`${String(Effect.isEffect(program))}`}>
      {identity([1, 2, 3]).map((n) => (
        <span key={n}>{n}</span>
      ))}
    </div>
  </ManagedRuntime.Provider>
);
