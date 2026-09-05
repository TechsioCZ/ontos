// expect-count: 3
import type { ReactElement } from 'react';

export type PanelState =
  | { readonly _tag: 'idle' }
  | { readonly _tag: 'loading' }
  | { readonly _tag: 'failed'; readonly problem: string };

export function Panel(props: { readonly state: PanelState }): ReactElement {
  return <div data-state={props.state._tag}>{props.state._tag}</div>;
}
