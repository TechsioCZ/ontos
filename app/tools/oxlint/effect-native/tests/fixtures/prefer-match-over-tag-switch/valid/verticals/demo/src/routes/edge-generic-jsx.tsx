import { Match } from 'effect';

import type { ReactElement } from 'react';

type Session = { readonly status: 'anonymous' } | { readonly status: 'authenticated' };

declare const Box: (props: { readonly label: string }) => ReactElement;

/** A generic arrow in a .tsx file, fragments and `satisfies` — and no switch anywhere. */
export const identity = <T,>(value: T): T => value;

export function Panel(props: { readonly session: Session }): ReactElement {
  const label = Match.value(props.session).pipe(
    Match.when({ status: 'anonymous' }, () => 'anonymous'),
    Match.when({ status: 'authenticated' }, () => 'authenticated'),
    Match.exhaustive,
  ) satisfies string;
  return (
    <>
      <Box label={identity(label)} />
    </>
  );
}
