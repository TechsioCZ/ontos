import type { ComponentType } from 'react';
import type { ResolvedModuleTarget } from '../../shared/api.ts';

export type ApprovedVerticalPageComponent = ComponentType<{
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
  {
    appId: 'crm',
    componentKey: 'crm.core.page-customers',
    load: () => import('crm/PageCustomers'),
  },
  {
    appId: 'crm',
    componentKey: 'crm.core.page-deals',
    load: () => import('crm/PageDeals'),
  },
  // @ontos-codegen-end shell-page-clients
];

export const findApprovedVerticalPageClient = (
  target: Pick<ResolvedModuleTarget, 'appId' | 'componentKey'>,
): ApprovedVerticalPageClient | undefined =>
  ultramodernVerticalClients.find(
    (client) => client.appId === target.appId && client.componentKey === target.componentKey,
  );
