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
  {
    appId: 'projects',
    componentKey: 'projects.core.page-contact-create',
    load: () => import('projects/PageContactCreate'),
  },
  {
    appId: 'projects',
    componentKey: 'projects.core.page-contact-detail',
    load: () => import('projects/PageContactDetail'),
  },
  {
    appId: 'projects',
    componentKey: 'projects.core.page-contact-edit',
    load: () => import('projects/PageContactEdit'),
  },
  {
    appId: 'projects',
    componentKey: 'projects.core.page-projects',
    load: () => import('projects/PageProjects'),
  },
  {
    appId: 'projects',
    componentKey: 'projects.core.page-customer-create',
    load: () => import('projects/PageCustomerCreate'),
  },
  {
    appId: 'projects',
    componentKey: 'projects.core.page-customer-detail',
    load: () => import('projects/PageCustomerDetail'),
  },
  {
    appId: 'projects',
    componentKey: 'projects.core.page-customer-edit',
    load: () => import('projects/PageCustomerEdit'),
  },
  {
    appId: 'projects',
    componentKey: 'projects.core.page-customers-list',
    load: () => import('projects/PageCustomersList'),
  },
  // @ontos-codegen-end shell-page-clients
];

export const findApprovedVerticalPageClient = (
  target: Pick<ResolvedModuleTarget, 'appId' | 'componentKey'>,
): ApprovedVerticalPageClient | undefined =>
  ultramodernVerticalClients.find(
    (client) => client.appId === target.appId && client.componentKey === target.componentKey,
  );
