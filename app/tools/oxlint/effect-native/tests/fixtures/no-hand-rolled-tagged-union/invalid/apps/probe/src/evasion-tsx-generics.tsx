// expect-count: 2
// TSX with JSX and a generic arrow (`<Value,>`) must still be walked.
import type { ReactElement } from 'react';

type Cell<Value> = { readonly _tag: 'filled'; readonly value: Value } | { readonly _tag: 'empty' };

const identity = <Value,>(value: Value): Value => value;

export function Grid(props: { readonly cells: readonly Cell<string>[] }): ReactElement {
  return (
    <ul className="grid">
      {props.cells.map((cell, index) => (
        <li key={index}>{cell._tag === 'filled' ? identity(cell.value) : <em>empty</em>}</li>
      ))}
    </ul>
  );
}
