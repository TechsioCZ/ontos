import type { ReactNode } from 'react';

/** Keep wide finance tables reachable inside the shell's clipped mobile content. */
export const FinanceTableScroll = ({ children, label }: { readonly children: ReactNode; readonly label: string }) => (
  /* oxlint-disable jsx-a11y/no-noninteractive-tabindex -- Approved demo/sales-crm: this named viewport needs keyboard scrolling. */
  <section
    aria-label={label}
    className="finance-table-scroll"
    data-finance-table-scroll
    style={{ maxWidth: '100%', minWidth: 0, overflowX: 'auto', width: '100%' }}
    tabIndex={0}
  >
    {/* oxlint-enable jsx-a11y/no-noninteractive-tabindex */}
    {children}
  </section>
);
