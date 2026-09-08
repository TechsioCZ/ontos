import type { ReactElement } from 'react';

declare const Badge: (props: { readonly status: number; readonly title: string }) => ReactElement;
declare const Panel: (props: { readonly problem: unknown }) => ReactElement;

// JSX attribute values are UI props rendered from an already-typed failure, not the wire contract.
export const Card = (): ReactElement => (
  <>
    <Badge status={503} title="Unavailable" />
    <Panel
      problem={{
        detail: 'Temporarily unavailable',
        retryable: true,
        status: 503,
        title: 'Unavailable',
        type: 'https://ontos.dev/problems/contacts-unavailable',
      }}
    />
  </>
);
