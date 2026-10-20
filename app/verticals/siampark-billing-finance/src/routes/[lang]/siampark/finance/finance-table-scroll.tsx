import type { ReactNode } from 'react';

/** Keep wide finance tables reachable inside the shell's clipped mobile content. */
export const FinanceTableScroll = ({ children, label }: { readonly children: ReactNode; readonly label: string }) => (
  <div
    aria-label={label}
    className="finance-table-scroll"
    data-finance-table-scroll
    role="region"
    style={{ maxWidth: '100%', minWidth: 0, overflowX: 'auto', width: '100%' }}
    tabIndex={0}
  >
    {children}
  </div>
);
