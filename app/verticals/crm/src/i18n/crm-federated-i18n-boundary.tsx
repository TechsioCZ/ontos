import { FederatedI18nBoundary } from '@modern-js/plugin-i18n/runtime';
import type { ReactNode } from 'react';
import csResource from '../../locales/cs/crm.json';
import enResource from '../../locales/en/crm.json';
import { ultramodernRouteNamespace } from '../routes/ultramodern-route-metadata';
import { createCrmI18nResources, crmSupportedLanguages } from './crm-i18n-resources';

const resources = createCrmI18nResources({ cs: csResource, en: enResource });

export const CrmFederatedI18nBoundary = ({ children }: { readonly children: ReactNode }) => (
  <FederatedI18nBoundary
    defaultNamespace={ultramodernRouteNamespace}
    fallbackLanguage="en"
    resources={resources}
    supportedLanguages={crmSupportedLanguages}
  >
    {children}
  </FederatedI18nBoundary>
);
