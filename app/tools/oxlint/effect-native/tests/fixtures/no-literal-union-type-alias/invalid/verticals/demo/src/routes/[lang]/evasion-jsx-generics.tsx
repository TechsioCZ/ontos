// expect-count: 2
import type { ReactElement } from 'react';

const identity = <T,>(value: T): T => value;

export function Panel(): ReactElement {
  type PanelState = 'error' | 'loading' | 'ready';
  const state: PanelState = identity<PanelState>('ready');
  return (
    <>
      <span>{state}</span>
    </>
  );
}

export type PanelTone = 'danger' | 'neutral' | 'primary';
