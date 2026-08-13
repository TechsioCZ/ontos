import '../routes/index.css';

import type { ComponentProps } from 'react';
import { CrmFederatedI18nBoundary } from '../i18n/crm-federated-i18n-boundary.tsx';
import { CustomersPage } from '../routes/[lang]/customers/page.tsx';

const FederatedCustomersPage = (props: ComponentProps<typeof CustomersPage>) => (
  <CrmFederatedI18nBoundary>
    <CustomersPage {...props} />
  </CrmFederatedI18nBoundary>
);

export default FederatedCustomersPage;
