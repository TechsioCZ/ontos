// expect-count: 2
import type { ReactElement } from 'react';

declare const StatusCard: (props: { readonly problem: unknown }) => ReactElement;
declare const parseFailure: { readonly stack?: string };

// Reported: a hand-built payload returned from the outer HTTP seam.
export const toProblem = () => ({
  _tag: 'ShellInternalProblem',
  detail: `Decoding failed: ${parseFailure.stack}`,
  status: 500,
  title: 'Shell operation failed',
  type: 'https://ontos.dev/problems/shell-failed',
});

// Not reported: JSX attribute values are UI props, not the wire contract.
export const Card = (): ReactElement => (
  <StatusCard problem={{ status: 503, title: 'Unavailable', type: 'https://ontos.dev/problems/x' }} />
);
