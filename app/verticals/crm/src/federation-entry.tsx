import './routes/index.css';

import type { ComponentProps } from 'react';
import { CrmFederatedI18nBoundary } from './i18n/crm-federated-i18n-boundary.tsx';
import { CustomersPage } from './routes/[lang]/customers/page.tsx';
import { DealsPage } from './routes/[lang]/deals/page.tsx';

export const PageCustomers = (props: ComponentProps<typeof CustomersPage>) => (
  <CrmFederatedI18nBoundary>
    <CustomersPage {...props} />
  </CrmFederatedI18nBoundary>
);

export const PageDeals = (props: ComponentProps<typeof DealsPage>) => (
  <CrmFederatedI18nBoundary>
    <DealsPage {...props} />
  </CrmFederatedI18nBoundary>
);
