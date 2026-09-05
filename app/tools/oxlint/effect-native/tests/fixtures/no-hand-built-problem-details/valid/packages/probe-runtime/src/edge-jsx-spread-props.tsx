// The same UI-prop carve-out as `<Panel problem={{ … }} />`, written as a spread attribute.
import type { ReactElement } from 'react';

declare const Panel: (props: Record<string, unknown>) => ReactElement;

export const Spread = (): ReactElement => (
  <Panel
    {...{
      detail: 'Temporarily unavailable',
      status: 503,
      title: 'Unavailable',
      type: 'https://ontos.dev/problems/contacts-unavailable',
    }}
  />
);
