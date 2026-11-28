import { ScrollRegion } from '@app/admin-ui';
import type { ReactNode } from 'react';

/** Keep wide finance tables reachable inside the shell's clipped mobile content. */
export const FinanceTableScroll = ({ children, label }: { readonly children: ReactNode; readonly label: string }) => (
  <ScrollRegion className="w-full min-w-0 max-w-full overflow-x-auto" label={label}>
    {children}
  </ScrollRegion>
);
