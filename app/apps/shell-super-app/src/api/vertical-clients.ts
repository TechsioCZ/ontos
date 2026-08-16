import type { ComponentType } from 'react';
import type { ResolvedModuleTarget } from '../../shared/api.ts';

export type ApprovedVerticalPageComponent = ComponentType<{
  readonly routeParams: Readonly<Record<string, string>>;
  readonly target: ResolvedModuleTarget;
}>;

export interface ApprovedVerticalPageClient {
  readonly appId: string;
  readonly componentKey: string;
  readonly load: () => Promise<{ readonly default: ApprovedVerticalPageComponent }>;
}

/** Codesmith-owned allowlist. Executable imports remain lazy and owner-deployment-specific. */
export const ultramodernVerticalClients: readonly ApprovedVerticalPageClient[] = [
  // @ontos-codegen-start shell-page-clients
  { appId: 'crm', componentKey: 'crm.core.page-crm', load: () => import('crm/PageCrm') },
  {
    appId: 'crm',
    componentKey: 'crm.core.page-customer-create',
    load: () => import('crm/PageCustomerCreate'),
  },
  {
    appId: 'crm',
    componentKey: 'crm.core.page-customer-detail',
    load: () => import('crm/PageCustomerDetail'),
  },
  {
    appId: 'crm',
    componentKey: 'crm.core.page-customer-edit',
    load: () => import('crm/PageCustomerEdit'),
  },
  {
    appId: 'crm',
    componentKey: 'crm.core.page-customers-list',
    load: () => import('crm/PageCustomersList'),
  },
  // @ontos-codegen-end shell-page-clients
];

export const findApprovedVerticalPageClient = (
  target: Pick<ResolvedModuleTarget, 'appId' | 'componentKey'>,
): ApprovedVerticalPageClient | undefined =>
  ultramodernVerticalClients.find(
    (client) => client.appId === target.appId && client.componentKey === target.componentKey,
  );
