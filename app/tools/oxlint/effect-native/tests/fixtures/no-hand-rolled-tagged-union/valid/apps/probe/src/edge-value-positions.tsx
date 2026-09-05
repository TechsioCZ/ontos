import type { ReactElement } from 'react';

const literal = { _tag: 'Value', status: 200 } as const;
const asserted = { _tag: 'Asserted' } as { readonly _tag: 'Asserted' };
const satisfied = { _tag: 'Satisfied' } satisfies { readonly _tag: string };

export function Badge(): ReactElement {
  return (
    <span title={`${literal._tag}/${asserted._tag}`}>
      {satisfied._tag}
      <b>{literal.status}</b>
    </span>
  );
}
