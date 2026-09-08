// expect-count: 2
import type { ReactElement } from 'react';

type Session = { readonly status: 'anonymous' } | { readonly status: 'authenticated' };

declare const session: Session;
declare const error: { readonly _tag: 'Denied' | 'Offline' };
declare const Box: () => ReactElement;
declare const Button: (props: {
  readonly onClick: () => void;
  readonly children?: unknown;
}) => ReactElement;

/** Buried inside a JSX attribute callback and a JSX-child IIFE. */
export function Panel(): ReactElement {
  return (
    <>
      <Button
        onClick={() => {
          switch (session.status) {
            case 'anonymous': {
              break;
            }
            case 'authenticated': {
              break;
            }
          }
        }}
      >
        {((): ReactElement => {
          switch (error._tag) {
            case 'Denied': {
              return <Box />;
            }
            case 'Offline': {
              return <Box />;
            }
          }
        })()}
      </Button>
    </>
  );
}
