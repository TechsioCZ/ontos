import { ScrollRegion } from '@app/admin-ui';
import type { ReactNode } from 'react';

const financeTableViewport = { maxWidth: '100%', minWidth: 0, overflowX: 'auto', width: '100%' } as const;

/** Keep wide finance tables reachable inside the shell's clipped mobile content. */
export const FinanceTableScroll = ({ children, label }: { readonly children: ReactNode; readonly label: string }) => (
  <ScrollRegion className="finance-table-scroll" label={label} style={financeTableViewport}>
    {children}
  </ScrollRegion>
);
