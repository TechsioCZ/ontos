// Frame of every CRM page (owned by crm-scaffold): i18n boundary, document title, layout column and toaster.
import { Toaster } from '@app/admin-ui';
import { FederatedI18nBoundary, useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Helmet } from '@modern-js/runtime/head';
import type { ReactNode } from 'react';
import '../routes/index.css';
import { crmI18nResources } from './i18n.ts';

const CrmHead = ({ titleKey }: { readonly titleKey: string }) => {
  const { language, t } = useModernI18n();
  return (
    <Helmet htmlAttributes={{ lang: language ?? 'cs' }}>
      <title>{t(titleKey)}</title>
      <meta content="noindex, nofollow" name="robots" />
    </Helmet>
  );
};

export const CrmPage = ({ children, titleKey }: { readonly children: ReactNode; readonly titleKey: string }) => (
  <FederatedI18nBoundary
    defaultNamespace="crm"
    fallbackLanguage="en"
    resources={crmI18nResources}
    supportedLanguages={['en', 'cs']}
  >
    <CrmHead titleKey={titleKey} />
    <section className="flex min-w-0 flex-col gap-250">{children}</section>
    <Toaster />
  </FederatedI18nBoundary>
);
