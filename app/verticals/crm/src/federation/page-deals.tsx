import '../routes/index.css';

import type { ComponentProps } from 'react';
import { CrmFederatedI18nBoundary } from '../i18n/crm-federated-i18n-boundary.tsx';
import { DealsPage } from '../routes/[lang]/deals/page.tsx';

const FederatedDealsPage = (props: ComponentProps<typeof DealsPage>) => (
  <CrmFederatedI18nBoundary>
    <DealsPage {...props} />
  </CrmFederatedI18nBoundary>
);

export default FederatedDealsPage;
